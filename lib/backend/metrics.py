"""
Quality and cost metrics for CT compression evaluation.

Includes PSNR, SSIM, token estimation, and cost calculations.
"""

import numpy as np
from typing import Dict, Tuple, Optional


def calculate_psnr(original: np.ndarray, reconstructed: np.ndarray, 
                   data_range: Optional[float] = None,
                   body_threshold: float = -900) -> float:
    """
    Calculate Peak Signal-to-Noise Ratio in dB on body region.
    
    Higher is better. Target: >40 dB for excellent quality.
    Excludes air/background (HU < threshold) for accurate diagnostic quality.
    
    Args:
        original: Original image/volume
        reconstructed: Reconstructed image/volume
        data_range: Dynamic range (max - min). Auto-calculated if None.
        body_threshold: HU threshold for body region (default -900)
    
    Returns:
        PSNR value in dB
    """
    if data_range is None:
        # For CT, typical range is -1024 to 3071 HU
        data_range = 4095.0
    
    # Create mask for body region (exclude air/background)
    body_mask = original > body_threshold
    
    if np.sum(body_mask) == 0:
        # Fall back to full volume if no body detected
        mse = np.mean((original.astype(np.float64) - reconstructed.astype(np.float64)) ** 2)
    else:
        orig_body = original[body_mask].astype(np.float64)
        recon_body = reconstructed[body_mask].astype(np.float64)
        mse = np.mean((orig_body - recon_body) ** 2)
    
    if mse == 0:
        return float('inf')
    
    psnr = 10 * np.log10((data_range ** 2) / mse)
    return float(psnr)


def calculate_ssim(original: np.ndarray, reconstructed: np.ndarray,
                   data_range: Optional[float] = None,
                   win_size: int = 7) -> float:
    """
    Calculate Structural Similarity Index (SSIM).
    
    Range: 0-1, higher is better. Target: >0.95 for excellent quality.
    
    Uses simplified implementation to avoid dependency on skimage.metrics.
    """
    try:
        from skimage.metrics import structural_similarity as ssim
        if data_range is None:
            data_range = 4095.0
        
        # For 3D volumes, compute mean SSIM across slices
        if original.ndim == 3:
            ssim_values = []
            for i in range(original.shape[0]):
                s = ssim(original[i], reconstructed[i], data_range=data_range,
                        win_size=min(win_size, min(original[i].shape) - 1))
                ssim_values.append(s)
            return float(np.mean(ssim_values))
        else:
            return float(ssim(original, reconstructed, data_range=data_range,
                            win_size=min(win_size, min(original.shape) - 1)))
    except ImportError:
        # Fallback to simple correlation-based metric
        return _simple_ssim(original, reconstructed)


def _simple_ssim(original: np.ndarray, reconstructed: np.ndarray) -> float:
    """Simplified SSIM approximation using correlation."""
    # Normalize
    orig_norm = (original - np.mean(original)) / (np.std(original) + 1e-8)
    recon_norm = (reconstructed - np.mean(reconstructed)) / (np.std(reconstructed) + 1e-8)
    
    # Correlation coefficient
    corr = np.mean(orig_norm * recon_norm)
    
    # Map to 0-1 range (correlation is -1 to 1)
    return float(max(0, (corr + 1) / 2))


def calculate_volume_stats(volume: np.ndarray) -> Dict:
    """Calculate HU statistics for a volume."""
    return {
        "min": int(np.min(volume)),
        "max": int(np.max(volume)),
        "mean": round(float(np.mean(volume)), 1),
        "std": round(float(np.std(volume)), 1),
    }


def estimate_tokens(data_bytes: int) -> int:
    """
    Estimate LLM tokens for data.
    
    Uses conservative estimate: tokens ≈ bytes / 4
    This accounts for base64 encoding and tokenization overhead.
    """
    return data_bytes // 4


def calculate_cost(tokens: int, cost_per_1m_tokens: float = 0.03) -> float:
    """Calculate cost in USD for given token count."""
    return tokens * cost_per_1m_tokens / 1_000_000


def calculate_cost_savings(original_bytes: int, compressed_bytes: int,
                          cost_per_1m_tokens: float = 0.03) -> Dict:
    """
    Calculate token and cost savings from compression.
    
    Args:
        original_bytes: Size before compression
        compressed_bytes: Size after compression
        cost_per_1m_tokens: Cost per million input tokens (default: $0.03)
    
    Returns:
        Dict with token counts, savings percentage, and cost estimates
    """
    original_tokens = estimate_tokens(original_bytes)
    compressed_tokens = estimate_tokens(compressed_bytes)
    
    savings_pct = (1 - compressed_tokens / original_tokens) * 100 if original_tokens > 0 else 0
    
    original_cost = calculate_cost(original_tokens, cost_per_1m_tokens)
    compressed_cost = calculate_cost(compressed_tokens, cost_per_1m_tokens)
    savings_per_query = original_cost - compressed_cost
    
    return {
        "original_tokens": original_tokens,
        "compressed_tokens": compressed_tokens,
        "savings_pct": round(savings_pct, 1),
        "original_cost_usd": round(original_cost, 6),
        "compressed_cost_usd": round(compressed_cost, 6),
        "savings_per_query_usd": round(savings_per_query, 6),
        "monthly_savings_1k_queries": round(savings_per_query * 1000, 2),
    }


def calculate_compression_metrics(original_volume: np.ndarray,
                                   reconstructed_volume: np.ndarray,
                                   original_bytes: int,
                                   compressed_bytes: int,
                                   processing_time: float) -> Dict:
    """
    Calculate complete compression metrics.
    
    Args:
        original_volume: Original CT volume
        reconstructed_volume: Reconstructed volume after decompression
        original_bytes: Original size in bytes
        compressed_bytes: Compressed size in bytes
        processing_time: Time taken for compression in seconds
    
    Returns:
        Comprehensive metrics dict
    """
    # Size metrics
    original_mb = original_bytes / (1024 * 1024)
    compressed_mb = compressed_bytes / (1024 * 1024)
    ratio = original_bytes / compressed_bytes if compressed_bytes > 0 else 0
    
    # Quality metrics
    psnr = calculate_psnr(original_volume, reconstructed_volume)
    ssim = calculate_ssim(original_volume, reconstructed_volume)
    
    # Cost metrics
    cost_metrics = calculate_cost_savings(original_bytes, compressed_bytes)
    
    return {
        "size": {
            "original_mb": round(original_mb, 1),
            "compressed_mb": round(compressed_mb, 1),
            "ratio": round(ratio, 2),
        },
        "quality": {
            "psnr_db": round(psnr, 1),
            "ssim": round(ssim, 3),
        },
        "performance": {
            "processing_time_sec": round(processing_time, 1),
            "throughput_mb_per_sec": round(original_mb / processing_time, 1) if processing_time > 0 else 0,
        },
        "tokens": cost_metrics,
    }


def format_metrics_report(metrics: Dict, patient_id: str = "unknown") -> str:
    """Format metrics as human-readable console output."""
    size = metrics.get("size", {})
    quality = metrics.get("quality", {})
    tokens = metrics.get("tokens", {})
    perf = metrics.get("performance", {})
    
    lines = [
        "",
        "Results:",
        f"  Original:     {size.get('original_mb', 0):.1f} MB",
        f"  Compressed:   {size.get('compressed_mb', 0):.1f} MB",
        f"  Ratio:        {size.get('ratio', 0):.1f}:1",
        f"  Quality:      PSNR={quality.get('psnr_db', 0):.1f}dB, SSIM={quality.get('ssim', 0):.3f}",
        "",
        "Token Savings:",
        f"  Before:       {tokens.get('original_tokens', 0):,} tokens",
        f"  After:        {tokens.get('compressed_tokens', 0):,} tokens",
        f"  Saved:        {tokens.get('savings_pct', 0):.1f}%",
        f"  Cost/query:   ${tokens.get('compressed_cost_usd', 0):.4f} (vs ${tokens.get('original_cost_usd', 0):.4f})",
        f"  Monthly (1K): ${tokens.get('compressed_cost_usd', 0) * 1000:.2f} (vs ${tokens.get('original_cost_usd', 0) * 1000:.2f}) → Save ${tokens.get('monthly_savings_1k_queries', 0):.2f}/mo",
    ]
    
    if perf:
        lines.insert(5, f"  Time:         {perf.get('processing_time_sec', 0):.1f}s ({perf.get('throughput_mb_per_sec', 0):.1f} MB/s)")
    
    return "\n".join(lines)


def verify_reconstruction(original: np.ndarray, reconstructed: np.ndarray,
                         psnr_threshold: float = 35.0, 
                         ssim_threshold: float = 0.90) -> Tuple[bool, Dict]:
    """
    Verify that reconstruction meets quality thresholds.
    
    Returns:
        (passed, metrics_dict)
    """
    psnr = calculate_psnr(original, reconstructed)
    ssim = calculate_ssim(original, reconstructed)
    
    passed = psnr >= psnr_threshold and ssim >= ssim_threshold
    
    return passed, {
        "psnr_db": round(psnr, 1),
        "ssim": round(ssim, 3),
        "psnr_threshold": psnr_threshold,
        "ssim_threshold": ssim_threshold,
        "passed": passed,
    }


if __name__ == "__main__":
    # Quick test
    import numpy as np
    
    # Create test volumes
    original = np.random.randn(100, 256, 256).astype(np.float32) * 500 - 500
    noisy = original + np.random.randn(*original.shape).astype(np.float32) * 10
    
    psnr = calculate_psnr(original, noisy)
    ssim = calculate_ssim(original, noisy)
    
    print(f"Test PSNR: {psnr:.1f} dB")
    print(f"Test SSIM: {ssim:.3f}")
    
    # Test cost calculations
    cost = calculate_cost_savings(500 * 1024 * 1024, 100 * 1024 * 1024)
    print(f"\nCost savings: {cost['savings_pct']:.1f}%")
    print(f"Monthly savings (1K queries): ${cost['monthly_savings_1k_queries']:.2f}")
