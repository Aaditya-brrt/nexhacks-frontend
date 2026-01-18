"""
DICOM I/O utilities for loading CT volumes from LIDC-IDRI dataset.

Handles series selection, slice ordering, and robust loading of DICOM files.
"""

import os
from pathlib import Path
from collections import defaultdict
from typing import Tuple, Dict, Optional, List
import warnings

import numpy as np
import pydicom
from pydicom.errors import InvalidDicomError


def find_dicom_files(folder_path: str) -> List[Path]:
    """Recursively find all DICOM files in folder."""
    folder = Path(folder_path)
    dcm_files = []
    
    for path in folder.rglob("*"):
        if path.is_file():
            # Check for .dcm extension or try reading as DICOM
            if path.suffix.lower() == ".dcm":
                dcm_files.append(path)
            elif path.suffix == "" and not path.name.startswith("."):
                # Some DICOM files have no extension
                try:
                    pydicom.dcmread(path, stop_before_pixels=True, force=True)
                    dcm_files.append(path)
                except:
                    pass
    
    return dcm_files


def group_by_series(dcm_files: List[Path]) -> Dict[str, List[Tuple[Path, pydicom.Dataset]]]:
    """
    Group DICOM files by SeriesInstanceUID.
    
    Returns dict mapping SeriesInstanceUID -> list of (path, dataset) tuples.
    Filters to only CT modality files.
    """
    series_groups = defaultdict(list)
    
    for fpath in dcm_files:
        try:
            ds = pydicom.dcmread(fpath, stop_before_pixels=True, force=True)
            
            # Skip non-CT modalities (SEG, SR, etc.)
            modality = getattr(ds, "Modality", "").upper()
            if modality != "CT":
                continue
            
            # Get SeriesInstanceUID
            series_uid = getattr(ds, "SeriesInstanceUID", None)
            if series_uid is None:
                continue
                
            series_groups[series_uid].append((fpath, ds))
            
        except (InvalidDicomError, Exception) as e:
            # Skip corrupt or unreadable files
            warnings.warn(f"Skipping unreadable file: {fpath.name}")
            continue
    
    return dict(series_groups)


def select_axial_ct_series(series_groups: Dict[str, List[Tuple[Path, pydicom.Dataset]]]) -> Optional[str]:
    """
    Select the primary axial chest CT series.
    
    Strategy:
    - Pick series with most slices (typically 100-400 for chest CT)
    - Skip scout/localizer series (<20 slices)
    - Skip very small series that are likely secondary captures
    """
    MIN_SLICES = 20  # Scout/localizer threshold
    
    valid_series = {}
    for uid, files in series_groups.items():
        slice_count = len(files)
        if slice_count >= MIN_SLICES:
            valid_series[uid] = slice_count
    
    if not valid_series:
        return None
    
    # Return series with maximum slice count
    return max(valid_series, key=valid_series.get)


def sort_slices(files_with_datasets: List[Tuple[Path, pydicom.Dataset]]) -> List[Tuple[Path, pydicom.Dataset]]:
    """
    Sort slices by Z-position (ImagePositionPatient[2]) or InstanceNumber fallback.
    """
    def get_sort_key(item):
        path, ds = item
        
        # Primary: ImagePositionPatient Z-coordinate
        ipp = getattr(ds, "ImagePositionPatient", None)
        if ipp is not None and len(ipp) >= 3:
            return float(ipp[2])
        
        # Fallback: InstanceNumber
        instance_num = getattr(ds, "InstanceNumber", None)
        if instance_num is not None:
            return float(instance_num)
        
        # Last resort: filename
        return str(path)
    
    return sorted(files_with_datasets, key=get_sort_key)


def extract_pixel_array(ds: pydicom.Dataset) -> np.ndarray:
    """
    Extract pixel array and apply rescale slope/intercept for HU values.
    """
    pixels = ds.pixel_array.astype(np.float32)
    
    # Apply rescale to get Hounsfield Units
    slope = getattr(ds, "RescaleSlope", 1.0)
    intercept = getattr(ds, "RescaleIntercept", 0.0)
    
    return pixels * float(slope) + float(intercept)


def load_ct_volume(folder_path: str) -> Tuple[np.ndarray, Dict]:
    """
    Load chest CT volume from LIDC-IDRI patient folder.
    
    Args:
        folder_path: Path to patient folder (e.g., /data/LIDC-IDRI-0001)
    
    Returns:
        volume: ndarray of shape (slices, height, width) in Hounsfield Units
        metadata: dict with spacing, patient_id, series_uid, etc.
    
    Raises:
        ValueError: If no valid CT series found
    """
    folder = Path(folder_path)
    patient_id = folder.name
    
    print(f"Loading: {folder_path}")
    
    # Find all DICOM files
    dcm_files = find_dicom_files(folder_path)
    if not dcm_files:
        raise ValueError(f"No DICOM files found in {folder_path}")
    
    # Group by series
    series_groups = group_by_series(dcm_files)
    if not series_groups:
        raise ValueError(f"No valid CT series found in {folder_path}")
    
    print(f"  ✓ Found {len(series_groups)} series, ", end="")
    
    # Select primary axial CT
    selected_uid = select_axial_ct_series(series_groups)
    if selected_uid is None:
        raise ValueError(f"No axial CT series with sufficient slices found")
    
    print(f"selected Series UID: {selected_uid[:30]}...")
    
    # Sort slices
    files_with_ds = series_groups[selected_uid]
    sorted_files = sort_slices(files_with_ds)
    
    # Load pixel arrays
    slices = []
    first_ds = None
    
    for fpath, ds in sorted_files:
        try:
            # Re-read with pixel data
            full_ds = pydicom.dcmread(fpath, force=True)
            pixel_array = extract_pixel_array(full_ds)
            slices.append(pixel_array)
            
            if first_ds is None:
                first_ds = full_ds
                
        except Exception as e:
            warnings.warn(f"Skipping corrupt slice: {fpath.name} ({e})")
            continue
    
    if not slices:
        raise ValueError("Failed to load any valid slices")
    
    # Stack into 3D volume
    volume = np.stack(slices, axis=0)
    
    # Extract metadata
    pixel_spacing = getattr(first_ds, "PixelSpacing", [1.0, 1.0])
    slice_thickness = getattr(first_ds, "SliceThickness", 1.0)
    
    # Calculate actual slice spacing from positions if available
    if len(sorted_files) >= 2:
        _, ds1 = sorted_files[0]
        _, ds2 = sorted_files[1]
        ipp1 = getattr(ds1, "ImagePositionPatient", None)
        ipp2 = getattr(ds2, "ImagePositionPatient", None)
        if ipp1 and ipp2:
            slice_spacing = abs(float(ipp2[2]) - float(ipp1[2]))
        else:
            slice_spacing = float(slice_thickness) if slice_thickness else 1.0
    else:
        slice_spacing = float(slice_thickness) if slice_thickness else 1.0
    
    metadata = {
        "patient_id": patient_id,
        "series_uid": selected_uid,
        "shape": list(volume.shape),
        "spacing_mm": [
            float(pixel_spacing[0]),
            float(pixel_spacing[1]),
            slice_spacing
        ],
        "rows": int(getattr(first_ds, "Rows", volume.shape[1])),
        "columns": int(getattr(first_ds, "Columns", volume.shape[2])),
        "bits_stored": int(getattr(first_ds, "BitsStored", 16)),
        "window_center": float(getattr(first_ds, "WindowCenter", -600) if not isinstance(getattr(first_ds, "WindowCenter", -600), pydicom.multival.MultiValue) else getattr(first_ds, "WindowCenter", [-600])[0]),
        "window_width": float(getattr(first_ds, "WindowWidth", 1500) if not isinstance(getattr(first_ds, "WindowWidth", 1500), pydicom.multival.MultiValue) else getattr(first_ds, "WindowWidth", [1500])[0]),
    }
    
    print(f"  ✓ Loaded {volume.shape[0]} axial slices ({volume.shape[1]}×{volume.shape[2]})")
    
    return volume, metadata


def calculate_volume_stats(volume: np.ndarray) -> Dict:
    """Calculate HU statistics for the volume."""
    return {
        "min": int(np.min(volume)),
        "max": int(np.max(volume)),
        "mean": float(np.mean(volume)),
        "std": float(np.std(volume)),
    }


if __name__ == "__main__":
    # Quick test
    import sys
    if len(sys.argv) > 1:
        volume, meta = load_ct_volume(sys.argv[1])
        print(f"\nVolume shape: {volume.shape}")
        print(f"Spacing (mm): {meta['spacing_mm']}")
        print(f"HU range: [{np.min(volume):.0f}, {np.max(volume):.0f}]")
