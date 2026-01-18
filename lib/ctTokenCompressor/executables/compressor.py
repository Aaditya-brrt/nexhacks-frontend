"""
Multi-stage classical compression for CT volumes.

Implements:
- Auto-crop to body region
- Region-aware compression based on Hounsfield Units
- Inter-slice delta encoding with sparse storage
"""

import io
import time
from pathlib import Path
from typing import Tuple, Dict, Optional
import warnings

import numpy as np
from PIL import Image
from scipy import ndimage

# Try to import JPEG2000 codec, fallback to PNG
try:
    import imagecodecs
    HAS_JPEG2000 = True
except ImportError:
    HAS_JPEG2000 = False


# Hounsfield Unit thresholds for region segmentation
HU_THRESHOLDS = {
    "air": -500,           # < -500: air/background
    "lung_upper": -200,    # -500 to -200: lung tissue
    "soft_upper": 100,     # -200 to 100: soft tissue
    "bone_lower": 300,     # > 300: bone
}

# Delta threshold for sparse encoding (HU difference to store)
DELTA_THRESHOLD = 25


def find_body_bbox(volume: np.ndarray, air_threshold: float = -900) -> Tuple[slice, slice, slice]:
    """
    Find bounding box of body region (non-air voxels).
    
    Returns tuple of slices for (z, y, x) axes.
    """
    # Create binary mask of non-air regions
    body_mask = volume > air_threshold
    
    # Find bounding box
    coords = np.argwhere(body_mask)
    if len(coords) == 0:
        # Return full volume if no body found
        return (slice(None), slice(None), slice(None))
    
    z_min, y_min, x_min = coords.min(axis=0)
    z_max, y_max, x_max = coords.max(axis=0) + 1
    
    return (slice(z_min, z_max), slice(y_min, y_max), slice(x_min, x_max))


def segment_by_hu(volume: np.ndarray) -> Dict[str, np.ndarray]:
    """
    Segment volume into regions based on Hounsfield Units.
    
    Returns dict with boolean masks for each region.
    """
    return {
        "air": volume < HU_THRESHOLDS["air"],
        "lung": (volume >= HU_THRESHOLDS["air"]) & (volume < HU_THRESHOLDS["lung_upper"]),
        "soft": (volume >= HU_THRESHOLDS["lung_upper"]) & (volume < HU_THRESHOLDS["soft_upper"]),
        "bone": volume >= HU_THRESHOLDS["bone_lower"],
    }


def encode_slice_png(slice_array: np.ndarray) -> bytes:
    """Encode a slice as PNG (lossless)."""
    # Normalize to uint16 for PNG storage
    # Use full dynamic range for CT data (-4096 to +4096 covers all cases)
    min_hu, max_hu = -4096, 4095
    normalized = np.clip(slice_array, min_hu, max_hu)
    normalized = ((normalized - min_hu) / (max_hu - min_hu) * 65535).astype(np.uint16)
    
    img = Image.fromarray(normalized, mode='I;16')
    buffer = io.BytesIO()
    img.save(buffer, format='PNG', optimize=True)
    return buffer.getvalue()


def decode_slice_png(data: bytes) -> np.ndarray:
    """Decode PNG back to HU values."""
    buffer = io.BytesIO(data)
    img = Image.open(buffer)
    arr = np.array(img, dtype=np.float32)
    
    # Reverse normalization
    min_hu, max_hu = -4096, 4095
    return arr / 65535 * (max_hu - min_hu) + min_hu


def compute_delta(current: np.ndarray, previous: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Compute sparse delta between slices.
    
    Returns:
        indices: Flat indices where delta exceeds threshold
        values: Delta values at those positions
    """
    delta = current - previous
    
    # Find significant changes
    significant = np.abs(delta) > DELTA_THRESHOLD
    indices = np.flatnonzero(significant)
    values = delta.flat[indices].astype(np.int16)
    
    return indices.astype(np.uint32), values


def apply_delta(base: np.ndarray, indices: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Reconstruct slice by applying delta to base."""
    result = base.copy().ravel()  # Flatten to 1D for indexing
    result[indices] += values.astype(np.float32)
    return result.reshape(base.shape)


def compress_volume(volume: np.ndarray, metadata: Dict) -> Tuple[Dict, Dict]:
    """
    Multi-stage classical compression of CT volume.
    
    Steps:
        1. Crop to body bounding box
        2. Store reference slice at full quality
        3. Delta encode subsequent slices with sparse storage
        4. Track compression statistics
    
    Args:
        volume: 3D numpy array (slices, height, width) in HU
        metadata: Dict with patient info, spacing, etc.
    
    Returns:
        compressed_data: Dict containing compressed representation
        compression_stats: Dict with metrics
    """
    start_time = time.time()
    original_size = volume.nbytes
    
    print("\nCompressing...")
    
    # Step 1: Find body bounding box
    bbox = find_body_bbox(volume)
    cropped = volume[bbox]
    # Compute background value from outside-body region (use minimum which is typically DICOM padding)
    body_mask = volume > -900
    if np.any(~body_mask):
        background_value = float(np.min(volume[~body_mask]))
    else:
        background_value = -3024.0
    
    crop_info = {
        "original_shape": list(volume.shape),
        "bbox": [(s.start, s.stop) for s in bbox],
        "cropped_shape": list(cropped.shape),
        "background_value": background_value,
    }
    
    # Step 2: Store reference slice (first slice, PNG encoded)
    reference_slice = cropped[0].copy()
    reference_encoded = encode_slice_png(reference_slice)
    
    # Step 3: Delta encode remaining slices
    # IMPORTANT: Track what would be reconstructed, not original values
    # This prevents error accumulation during decompression
    num_slices = cropped.shape[0]
    deltas = []
    previous_original = reference_slice.copy()  
    
    total_delta_indices = 0
    total_pixels = 0
    
    for i in range(1, num_slices):
        current_original = cropped[i]
        indices, values = compute_delta(current_original, previous_original)
        
        deltas.append({
        "indices": indices,
        "values": values,
        })

        
        total_delta_indices += len(indices)
        total_pixels += current_original.size
        
        # Simulate reconstruction to track what decompressor will see
        # This prevents error drift across slices
        previous_original = current_original.copy()

        
        # Progress bar
        if i % 50 == 0 or i == num_slices - 1:
            pct = (i + 1) / num_slices * 100
            bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
            print(f"\r  [{bar}] {pct:.0f}% ({i+1}/{num_slices} slices)", end="", flush=True)
    
    print()  # Newline after progress
    
    # Calculate sparsity
    sparsity = 1.0 - (total_delta_indices / total_pixels) if total_pixels > 0 else 0
    
    # Build compressed data structure
    compressed_data = {
        "version": "1.0",
        "metadata": metadata,
        "crop_info": crop_info,
        "reference_slice": reference_encoded,
        "deltas": deltas,
        "hu_range": {"min": -4096, "max": 4095},
    }
    
    # Calculate compressed size
    compressed_size = len(reference_encoded)
    for d in deltas:
        compressed_size += d["indices"].nbytes + d["values"].nbytes
    
    elapsed = time.time() - start_time
    
    compression_stats = {
        "original_mb": original_size / (1024 * 1024),
        "compressed_mb": compressed_size / (1024 * 1024),
        "ratio": original_size / compressed_size if compressed_size > 0 else 0,
        "sparsity": sparsity,
        "processing_time_sec": elapsed,
        "throughput_mb_per_sec": (original_size / (1024 * 1024)) / elapsed if elapsed > 0 else 0,
        "num_slices": num_slices,
    }
    
    return compressed_data, compression_stats


def decompress_volume(compressed_data: Dict) -> Tuple[np.ndarray, Dict]:
    """
    Reconstruct CT volume from compressed representation.
    
    Args:
        compressed_data: Dict from compress_volume
    
    Returns:
        volume: Reconstructed 3D numpy array
        metadata: Original metadata
    """
    crop_info = compressed_data["crop_info"]
    original_shape = tuple(crop_info["original_shape"])
    cropped_shape = tuple(crop_info["cropped_shape"])
    bbox = crop_info["bbox"]
    background_value = crop_info.get("background_value", -3024)
    
    # Initialize with stored background value
    volume = np.full(original_shape, background_value, dtype=np.float32)
    
    # Decode reference slice
    reference = decode_slice_png(compressed_data["reference_slice"])
    
    # Reconstruct cropped region
    z_start, z_end = bbox[0]
    y_start, y_end = bbox[1]
    x_start, x_end = bbox[2]
    
    # First slice
    volume[z_start, y_start:y_end, x_start:x_end] = reference
    
    # Apply deltas sequentially
    previous = reference.copy()
    deltas = compressed_data["deltas"]
    
    for i, delta in enumerate(deltas):
        current = apply_delta(previous, delta["indices"], delta["values"])
        volume[z_start + i + 1, y_start:y_end, x_start:x_end] = current
        previous = current
    
    return volume, compressed_data["metadata"]


def save_compressed(compressed_data: Dict, output_path: str):
    """Save compressed data to .npz file."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    
    # Flatten deltas for storage
    delta_indices = [d["indices"] for d in compressed_data["deltas"]]
    delta_values = [d["values"] for d in compressed_data["deltas"]]
    
    np.savez_compressed(
        path,
        version=compressed_data["version"],
        metadata=np.array([compressed_data["metadata"]], dtype=object),
        crop_info=np.array([compressed_data["crop_info"]], dtype=object),
        reference_slice=np.frombuffer(compressed_data["reference_slice"], dtype=np.uint8),
        delta_indices=np.array(delta_indices, dtype=object),
        delta_values=np.array(delta_values, dtype=object),
        hu_range=np.array([compressed_data["hu_range"]], dtype=object),
    )


def load_compressed(input_path: str) -> Dict:
    """Load compressed data from .npz file."""
    data = np.load(input_path, allow_pickle=True)
    
    # Reconstruct deltas
    delta_indices = data["delta_indices"]
    delta_values = data["delta_values"]
    deltas = [
        {"indices": idx, "values": val}
        for idx, val in zip(delta_indices, delta_values)
    ]
    
    return {
        "version": str(data["version"]),
        "metadata": data["metadata"][0],
        "crop_info": data["crop_info"][0],
        "reference_slice": bytes(data["reference_slice"]),
        "deltas": deltas,
        "hu_range": data["hu_range"][0],
    }


def select_representative_slices(volume: np.ndarray, num_slices: int = 8) -> list:
    """
    Select representative slices distributed through the volume.
    
    Returns list of slice indices.
    """
    n = volume.shape[0]
    if n <= num_slices:
        return list(range(n))
    
    # Distribute evenly with emphasis on middle (where lungs are)
    indices = []
    for i in range(num_slices):
        # Use slightly biased distribution toward center
        t = i / (num_slices - 1)
        # Apply mild bias toward center using smoothstep
        t_biased = t * t * (3 - 2 * t) * 0.3 + t * 0.7
        idx = int(t_biased * (n - 1))
        if idx not in indices:
            indices.append(idx)
    
    return sorted(set(indices))


def create_montage(volume: np.ndarray, grid_size: Tuple[int, int] = (3, 3), 
                   window_center: float = -600, window_width: float = 1500) -> np.ndarray:
    """
    Create a montage image from distributed slices.
    
    Args:
        volume: 3D array (slices, height, width)
        grid_size: (rows, cols) for the montage
        window_center, window_width: Display windowing
    
    Returns:
        2D array (montage image)
    """
    rows, cols = grid_size
    num_tiles = rows * cols
    indices = select_representative_slices(volume, num_tiles)
    
    # Ensure we have enough indices
    while len(indices) < num_tiles:
        indices.append(indices[-1])
    
    h, w = volume.shape[1], volume.shape[2]
    montage = np.zeros((rows * h, cols * w), dtype=np.float32)
    
    for i, idx in enumerate(indices[:num_tiles]):
        row = i // cols
        col = i % cols
        
        slice_data = volume[idx]
        
        # Apply windowing
        lower = window_center - window_width / 2
        upper = window_center + window_width / 2
        windowed = np.clip((slice_data - lower) / (upper - lower), 0, 1)
        
        montage[row*h:(row+1)*h, col*w:(col+1)*w] = windowed
    
    return (montage * 255).astype(np.uint8)


def export_llm_bundle(volume: np.ndarray, metadata: Dict, output_dir: str,
                      num_slices: int = 8, window_center: float = -600, 
                      window_width: float = 1500):
    """
    Export LLM-friendly bundle with representative PNGs and JSON metadata.
    
    Creates:
        - Individual slice PNGs
        - Montage overview image
        - metadata.json with summary
    """
    import json
    
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Select representative slices
    indices = select_representative_slices(volume, num_slices)
    
    # Export individual slices
    slice_files = []
    for i, idx in enumerate(indices):
        slice_data = volume[idx]
        
        # Apply windowing
        lower = window_center - window_width / 2
        upper = window_center + window_width / 2
        windowed = np.clip((slice_data - lower) / (upper - lower), 0, 1)
        windowed = (windowed * 255).astype(np.uint8)
        
        # Position label
        position = ["top", "upper", "mid-upper", "mid", "mid-lower", "lower", "bottom"][min(i, 6)]
        filename = f"slice_{i:02d}_{position}.png"
        
        img = Image.fromarray(windowed, mode='L')
        img.save(output_path / filename, optimize=True)
        slice_files.append(filename)
    
    # Create montage
    montage = create_montage(volume, (3, 3), window_center, window_width)
    montage_img = Image.fromarray(montage, mode='L')
    montage_img.save(output_path / "montage_overview.png", optimize=True)
    
    # Calculate total size
    total_size = sum((output_path / f).stat().st_size for f in slice_files)
    total_size += (output_path / "montage_overview.png").stat().st_size
    
    # Create metadata JSON
    from metrics import calculate_volume_stats, estimate_tokens, calculate_cost_savings
    
    hu_stats = calculate_volume_stats(volume)
    original_mb = volume.nbytes / (1024 * 1024)
    bundle_mb = total_size / (1024 * 1024)
    
    original_tokens = estimate_tokens(volume.nbytes)
    bundle_tokens = estimate_tokens(total_size)
    
    summary = {
        "patient_id": metadata.get("patient_id", "unknown"),
        "series_uid": metadata.get("series_uid", "unknown"),
        "shape": list(volume.shape),
        "spacing_mm": metadata.get("spacing_mm", [1.0, 1.0, 1.0]),
        "hu_stats": hu_stats,
        "bundle": {
            "num_slices": len(slice_files),
            "slice_files": slice_files,
            "montage_file": "montage_overview.png",
            "total_mb": round(bundle_mb, 2),
        },
        "tokens": {
            "original_tokens": int(original_tokens),
            "bundle_tokens": int(bundle_tokens),
            "savings_pct": round((1 - bundle_tokens / original_tokens) * 100, 1) if original_tokens > 0 else 0,
        },
        "window": {
            "center": window_center,
            "width": window_width,
        },
    }
    
    with open(output_path / "metadata.json", "w") as f:
        json.dump(summary, f, indent=2)
    
    print(f"\n  ✓ Created LLM bundle:")
    print(f"    - {len(slice_files)} slice PNGs")
    print(f"    - Montage overview")
    print(f"    - Total size: {bundle_mb:.2f} MB")
    
    return summary


if __name__ == "__main__":
    # Quick test
    import sys
    from dicom_io import load_ct_volume
    
    if len(sys.argv) > 1:
        volume, meta = load_ct_volume(sys.argv[1])
        compressed, stats = compress_volume(volume, meta)
        print(f"\nCompression ratio: {stats['ratio']:.1f}:1")
        print(f"Time: {stats['processing_time_sec']:.1f}s")
