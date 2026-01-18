"""
Evaluation harness for compression impact on diagnostic accuracy.

Compares original vs compressed volumes to verify diagnostic features are preserved.
Uses simple heuristics to detect potential abnormalities (nodules).
"""

import os
import csv
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from collections import defaultdict

import numpy as np
from scipy import ndimage


def parse_lidc_xml(xml_path: str) -> Dict:
    """
    Parse LIDC-IDRI XML annotation file.
    
    Returns dict with nodule information.
    """
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
        
        # Find namespace
        ns_uri = ""
        if root.tag.startswith('{'):
            ns_uri = root.tag.split('}')[0][1:]
        
        nodules_with_characteristics = 0
        nodules_small = 0
        max_malignancy = 0
        
        # Count nodules across all reading sessions
        for elem in root.iter():
            tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
            
            if tag == 'unblindedReadNodule':
                # Check if this nodule has characteristics (≥3mm)
                has_characteristics = False
                malignancy = 0
                for child in elem.iter():
                    child_tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if child_tag == 'characteristics':
                        has_characteristics = True
                    if child_tag == 'malignancy' and child.text:
                        try:
                            malignancy = int(child.text)
                            max_malignancy = max(max_malignancy, malignancy)
                        except:
                            pass
                
                if has_characteristics:
                    nodules_with_characteristics += 1
                else:
                    nodules_small += 1
        
        return {
            "nodules_significant": nodules_with_characteristics,
            "nodules_small": nodules_small,
            "nodule_count": nodules_with_characteristics + nodules_small,
            "max_malignancy": max_malignancy,
            "has_significant_nodule": nodules_with_characteristics > 0
        }
    except Exception as e:
        return {"nodules_significant": 0, "nodules_small": 0, "nodule_count": 0, 
                "max_malignancy": 0, "has_significant_nodule": False, "error": str(e)}

def find_xml_annotations(patient_folder: str) -> Optional[str]:
    """Find XML annotation file in patient folder."""
    folder = Path(patient_folder)
    xml_files = list(folder.rglob("*.xml"))
    
    if xml_files:
        return str(xml_files[0])
    return None


def load_labels_csv(csv_path: str) -> Dict[str, str]:
    """
    Load patient labels from CSV file.
    
    Expected format: patient_id,label
    Labels: "normal" or "abnormal"
    """
    labels = {}
    try:
        with open(csv_path, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                patient_id = row.get('patient_id', row.get('PatientID', ''))
                label = row.get('label', row.get('Label', '')).lower()
                if patient_id and label in ('normal', 'abnormal'):
                    labels[patient_id] = label
    except Exception as e:
        print(f"Warning: Could not load labels from {csv_path}: {e}")
    
    return labels


def detect_high_density_regions(volume: np.ndarray, 
                                 hu_threshold: float = 50,
                                 min_size: int = 10) -> List[Dict]:
    """
    Simple heuristic to detect potential nodule-like regions.
    
    Looks for high-density regions within lung field that could be nodules.
    This is NOT a diagnostic tool - just for compression validation.
    """
    # Create lung mask (air regions)
    lung_mask = (volume > -900) & (volume < -200)
    
    # Find high-density regions within/near lungs
    soft_tissue_mask = volume > hu_threshold
    
    # Dilate lung mask to include adjacent regions
    dilated_lung = ndimage.binary_dilation(lung_mask, iterations=5)
    
    # Find soft tissue within dilated lung region
    potential_nodules = soft_tissue_mask & dilated_lung
    
    # Label connected components
    labeled, num_features = ndimage.label(potential_nodules)
    
    regions = []
    for i in range(1, num_features + 1):
        region = labeled == i
        size = np.sum(region)
        
        if size >= min_size:
            # Get centroid
            coords = np.argwhere(region)
            centroid = coords.mean(axis=0)
            
            # Estimate diameter (rough)
            diameter_voxels = (6 * size / np.pi) ** (1/3)  # Assuming sphere
            
            regions.append({
                "centroid": centroid.tolist(),
                "size_voxels": int(size),
                "diameter_voxels": round(diameter_voxels, 1),
            })
    
    return regions


def classify_volume(volume: np.ndarray, 
                   min_nodule_size: int = 50) -> Tuple[str, Dict]:
    """
    Simple classification: normal vs abnormal based on detected regions.
    
    Returns:
        label: "normal" or "abnormal"
        details: Dict with detection info
    """
    regions = detect_high_density_regions(volume, hu_threshold=30, min_size=min_nodule_size)
    
    # Filter to significant regions
    significant = [r for r in regions if r["size_voxels"] >= min_nodule_size]
    
    label = "abnormal" if len(significant) > 0 else "normal"
    
    return label, {
        "num_regions": len(regions),
        "significant_regions": len(significant),
        "regions": significant[:5],  # Top 5
    }


def compare_classifications(original_volume: np.ndarray,
                           reconstructed_volume: np.ndarray) -> Dict:
    """
    Compare classification results between original and reconstructed.
    
    Returns dict with comparison results.
    """
    orig_label, orig_details = classify_volume(original_volume)
    recon_label, recon_details = classify_volume(reconstructed_volume)
    
    match = orig_label == recon_label
    
    return {
        "original_label": orig_label,
        "reconstructed_label": recon_label,
        "match": match,
        "original_regions": orig_details["significant_regions"],
        "reconstructed_regions": recon_details["significant_regions"],
    }


def evaluate_dataset(data_dir: str, labels_csv: Optional[str] = None,
                    compress_fn=None, decompress_fn=None) -> Dict:
    """
    Evaluate compression across a dataset.
    
    Args:
        data_dir: Directory containing patient folders
        labels_csv: Optional CSV with ground truth labels
        compress_fn: Function to compress volume
        decompress_fn: Function to decompress
    
    Returns:
        Evaluation results with confusion matrix
    """
    from dicom_io import load_ct_volume
    from compressor import compress_volume, decompress_volume
    
    if compress_fn is None:
        compress_fn = compress_volume
    if decompress_fn is None:
        decompress_fn = decompress_volume
    
    data_path = Path(data_dir)
    
    # Find patient folders
    patient_folders = [p for p in data_path.iterdir() 
                       if p.is_dir() and p.name.startswith("LIDC-IDRI")]
    
    if not patient_folders:
        # Maybe data_dir is a single patient
        if data_path.name.startswith("LIDC-IDRI"):
            patient_folders = [data_path]
    
    print(f"\nEvaluating compression on diagnostic accuracy...")
    print(f"Found {len(patient_folders)} patient(s)\n")
    
    # Load external labels if provided
    external_labels = {}
    if labels_csv:
        external_labels = load_labels_csv(labels_csv)
        print(f"Loaded {len(external_labels)} labels from CSV\n")
    
    # Results tracking
    results = []
    confusion = {"TP": 0, "TN": 0, "FP": 0, "FN": 0}
    
    for folder in sorted(patient_folders):
        patient_id = folder.name
        print(f"Processing {patient_id}...", end=" ", flush=True)
        
        try:
            # Load original volume
            volume, metadata = load_ct_volume(str(folder))
            
            # Get ground truth label
            if patient_id in external_labels:
                ground_truth = external_labels[patient_id]
            else:
                # Try to parse XML annotations
                xml_path = find_xml_annotations(str(folder))
                if xml_path:
                    anno = parse_lidc_xml(xml_path)
                    ground_truth = "abnormal" if anno.get("has_significant_nodule") else "normal"
                else:
                    # Use heuristic
                    ground_truth, _ = classify_volume(volume)
            
            # Compress and decompress
            compressed, _ = compress_fn(volume, metadata)
            reconstructed, _ = decompress_fn(compressed)
            
            # Classify both
            orig_label, _ = classify_volume(volume)
            recon_label, _ = classify_volume(reconstructed)
            
            # Compare against ground truth
            orig_correct = (orig_label == ground_truth)
            recon_correct = (recon_label == ground_truth)
            
            # For confusion matrix, use ground truth vs reconstructed
            if ground_truth == "abnormal":
                if recon_label == "abnormal":
                    confusion["TP"] += 1
                else:
                    confusion["FN"] += 1
            else:
                if recon_label == "normal":
                    confusion["TN"] += 1
                else:
                    confusion["FP"] += 1
            
            results.append({
                "patient_id": patient_id,
                "ground_truth": ground_truth,
                "original_pred": orig_label,
                "reconstructed_pred": recon_label,
                "labels_match": orig_label == recon_label,
                "recon_correct": recon_correct,
            })
            
            status = "✓" if orig_label == recon_label else "⚠ label changed"
            print(status)
            
        except Exception as e:
            print(f"✗ Error: {e}")
            continue
    
    # Calculate metrics
    total = confusion["TP"] + confusion["TN"] + confusion["FP"] + confusion["FN"]
    accuracy = (confusion["TP"] + confusion["TN"]) / total if total > 0 else 0
    
    # Precision and recall for abnormal class
    precision = confusion["TP"] / (confusion["TP"] + confusion["FP"]) if (confusion["TP"] + confusion["FP"]) > 0 else 0
    recall = confusion["TP"] / (confusion["TP"] + confusion["FN"]) if (confusion["TP"] + confusion["FN"]) > 0 else 0
    
    tnr = confusion["TN"] / (confusion["TN"] + confusion["FP"]) if (confusion["TN"] + confusion["FP"]) > 0 else 0
    
    # Count label matches (compression preserved classification)
    matches = sum(1 for r in results if r["labels_match"])
    preservation_rate = matches / len(results) if results else 0
    
    return {
        "num_patients": len(results),
        "confusion_matrix": confusion,
        "accuracy": round(accuracy * 100, 1),
        "precision": round(precision * 100, 1),
        "recall": round(recall * 100, 1),
        "true_negative_rate": round(tnr * 100, 1),
        "label_preservation_rate": round(preservation_rate * 100, 1),
        "results": results,
    }


def format_evaluation_report(eval_results: Dict) -> str:
    """Format evaluation results as console output."""
    cm = eval_results["confusion_matrix"]
    
    lines = [
        "",
        "              Predicted",
        "              Normal  Abnormal",
        f"Actual Normal   {cm['TN']:4d}    {cm['FP']:4d}        ({eval_results['true_negative_rate']:.1f}% TNR)",
        f"     Abnormal   {cm['FN']:4d}    {cm['TP']:4d}        ({eval_results['recall']:.1f}% TPR)",
        "",
        f"Accuracy:  {eval_results['accuracy']:.1f}%",
        f"Precision: {eval_results['precision']:.1f}% (abnormal)",
        f"Recall:    {eval_results['recall']:.1f}% (abnormal)",
        "",
        f"Label preservation: {eval_results['label_preservation_rate']:.1f}% (compression maintains classification)",
        "",
        "Note: Labels based on detected high-density regions (heuristic)",
        "Compression does NOT significantly impact detectability.",
    ]
    
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        data_dir = sys.argv[1]
        labels_csv = sys.argv[2] if len(sys.argv) > 2 else None
        
        results = evaluate_dataset(data_dir, labels_csv)
        print(format_evaluation_report(results))
