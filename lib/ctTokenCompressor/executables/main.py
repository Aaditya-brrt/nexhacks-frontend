#!/usr/bin/env python3
"""
Medical CT Compression Pipeline - CLI Entry Point

Usage:
    python main.py compress <input_folder> <output_folder>
    python main.py decompress <compressed_file> <output_folder>
    python main.py report <input_folder>
    python main.py export-llm <input_folder> <output_folder>
    python main.py evaluate <data_dir> [--labels <csv_file>]
    python main.py serve [--port <port>]
"""

import argparse
import sys
import json
from pathlib import Path


def cmd_compress(args):
    """Compress a CT volume from a patient folder."""
    from dicom_io import load_ct_volume
    from compressor import compress_volume, decompress_volume, save_compressed
    from metrics import calculate_compression_metrics, format_metrics_report
    
    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Load volume
    volume, metadata = load_ct_volume(str(input_path))
    original_bytes = volume.nbytes
    
    # Compress
    compressed_data, comp_stats = compress_volume(volume, metadata)
    
    # Save compressed
    compressed_file = output_path / "scan.npz"
    save_compressed(compressed_data, str(compressed_file))
    compressed_bytes = compressed_file.stat().st_size
    
    # Decompress for quality verification
    reconstructed, _ = decompress_volume(compressed_data)
    
    # Calculate and display metrics
    metrics = calculate_compression_metrics(
        volume, reconstructed,
        original_bytes, compressed_bytes,
        comp_stats["processing_time_sec"]
    )
    
    print(format_metrics_report(metrics, metadata.get("patient_id", "unknown")))
    
    # Save metrics JSON
    metrics_file = output_path / "metrics.json"
    with open(metrics_file, "w") as f:
        json.dump(metrics, f, indent=2)
    
    print(f"\n  ✓ Saved: {compressed_file}")
    print(f"  ✓ Metrics: {metrics_file}")


def cmd_decompress(args):
    """Decompress and verify a compressed CT volume."""
    from compressor import load_compressed, decompress_volume
    from metrics import verify_reconstruction
    import numpy as np
    
    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.mkdir(parents=True, exist_ok=True)
    
    print(f"\nLoading compressed: {input_path}")
    
    # Load and decompress
    compressed_data = load_compressed(str(input_path))
    reconstructed, metadata = decompress_volume(compressed_data)
    
    print(f"  ✓ Decompressed: {reconstructed.shape}")
    
    # Save as numpy array
    output_file = output_path / "volume.npy"
    np.save(output_file, reconstructed)
    
    # Save metadata
    meta_file = output_path / "metadata.json"
    with open(meta_file, "w") as f:
        json.dump(metadata, f, indent=2, default=str)
    
    print(f"\n  ✓ Saved volume: {output_file}")
    print(f"  ✓ Saved metadata: {meta_file}")
    print(f"\nReconstruction complete.")


def cmd_report(args):
    """Show compression report for a CT volume without saving."""
    from dicom_io import load_ct_volume, calculate_volume_stats
    from metrics import estimate_tokens, calculate_cost_savings
    
    input_path = Path(args.input)
    
    # Load volume
    volume, metadata = load_ct_volume(str(input_path))
    
    # Calculate stats
    hu_stats = calculate_volume_stats(volume)
    size_mb = volume.nbytes / (1024 * 1024)
    tokens = estimate_tokens(volume.nbytes)
    cost = calculate_cost_savings(volume.nbytes, volume.nbytes)
    
    print(f"\n{'='*50}")
    print(f"CT Volume Report: {metadata.get('patient_id', 'unknown')}")
    print(f"{'='*50}")
    print(f"\nVolume:")
    print(f"  Shape:        {volume.shape}")
    print(f"  Spacing (mm): {metadata.get('spacing_mm', [])}")
    print(f"  Size:         {size_mb:.1f} MB")
    
    print(f"\nHounsfield Units:")
    print(f"  Min:  {hu_stats['min']}")
    print(f"  Max:  {hu_stats['max']}")
    print(f"  Mean: {hu_stats['mean']:.1f}")
    print(f"  Std:  {hu_stats['std']:.1f}")
    
    print(f"\nLLM Cost (uncompressed):")
    print(f"  Tokens:       {tokens:,}")
    print(f"  Cost/query:   ${cost['original_cost_usd']:.4f}")
    print(f"  Monthly (1K): ${cost['original_cost_usd'] * 1000:.2f}")
    
    print(f"\n→ Use 'compress' command to reduce size and cost")


def cmd_export_llm(args):
    """Export LLM-friendly bundle with representative slices."""
    from dicom_io import load_ct_volume
    from compressor import export_llm_bundle
    
    input_path = Path(args.input)
    output_path = Path(args.output)
    
    # Load volume
    volume, metadata = load_ct_volume(str(input_path))
    
    # Export bundle
    summary = export_llm_bundle(
        volume, metadata, str(output_path),
        num_slices=args.num_slices,
        window_center=args.window_center,
        window_width=args.window_width
    )
    
    print(f"\n  ✓ Bundle saved to: {output_path}")


def cmd_evaluate(args):
    """Evaluate compression across dataset."""
    from evaluate import evaluate_dataset, format_evaluation_report
    
    data_dir = Path(args.data_dir)
    labels_csv = args.labels if hasattr(args, 'labels') else None
    
    results = evaluate_dataset(str(data_dir), labels_csv)
    print(format_evaluation_report(results))
    
    # Save results
    if args.output:
        output_path = Path(args.output)
        output_path.mkdir(parents=True, exist_ok=True)
        with open(output_path / "evaluation.json", "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\n  ✓ Results saved to: {output_path / 'evaluation.json'}")


def cmd_serve(args):
    """Start FastAPI server."""
    from api import run_server
    
    print(f"\nStarting Medical CT Compression API...")
    print(f"  URL: http://localhost:{args.port}")
    print(f"  Docs: http://localhost:{args.port}/docs")
    print(f"\nPress Ctrl+C to stop.\n")
    
    run_server(host=args.host, port=args.port)


def main():
    parser = argparse.ArgumentParser(
        description="Medical CT Compression Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py compress /data/LIDC-IDRI-0001 ./output
  python main.py decompress ./output/scan.npz ./reconstructed
  python main.py report /data/LIDC-IDRI-0001
  python main.py export-llm /data/LIDC-IDRI-0001 ./llm-bundle
  python main.py evaluate /data/LIDC-IDRI --labels nodules.csv
  python main.py serve --port 8000
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # compress
    p_compress = subparsers.add_parser("compress", help="Compress a CT volume")
    p_compress.add_argument("input", help="Path to patient folder with DICOM files")
    p_compress.add_argument("output", help="Output folder for compressed data")
    p_compress.set_defaults(func=cmd_compress)
    
    # decompress
    p_decompress = subparsers.add_parser("decompress", help="Decompress a compressed volume")
    p_decompress.add_argument("input", help="Path to compressed .npz file")
    p_decompress.add_argument("output", help="Output folder for reconstructed volume")
    p_decompress.set_defaults(func=cmd_decompress)
    
    # report
    p_report = subparsers.add_parser("report", help="Show volume report without compressing")
    p_report.add_argument("input", help="Path to patient folder with DICOM files")
    p_report.set_defaults(func=cmd_report)
    
    # export-llm
    p_llm = subparsers.add_parser("export-llm", help="Export LLM-friendly bundle")
    p_llm.add_argument("input", help="Path to patient folder with DICOM files")
    p_llm.add_argument("output", help="Output folder for LLM bundle")
    p_llm.add_argument("--num-slices", type=int, default=8, help="Number of representative slices")
    p_llm.add_argument("--window-center", type=float, default=-600, help="Display window center (HU)")
    p_llm.add_argument("--window-width", type=float, default=1500, help="Display window width (HU)")
    p_llm.set_defaults(func=cmd_export_llm)
    
    # evaluate
    p_eval = subparsers.add_parser("evaluate", help="Evaluate compression on dataset")
    p_eval.add_argument("data_dir", help="Directory containing patient folders")
    p_eval.add_argument("--labels", help="CSV file with patient labels")
    p_eval.add_argument("--output", help="Output folder for results")
    p_eval.set_defaults(func=cmd_evaluate)
    
    # serve
    p_serve = subparsers.add_parser("serve", help="Start FastAPI server")
    p_serve.add_argument("--host", default="0.0.0.0", help="Host to bind")
    p_serve.add_argument("--port", type=int, default=8000, help="Port to listen on")
    p_serve.set_defaults(func=cmd_serve)
    
    args = parser.parse_args()
    
    if args.command is None:
        parser.print_help()
        sys.exit(1)
    
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
        sys.exit(0)
    except Exception as e:
        print(f"\n✗ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
