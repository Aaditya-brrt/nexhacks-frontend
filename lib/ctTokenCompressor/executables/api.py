"""
FastAPI backend for medical CT compression pipeline.

Provides REST endpoints for compression jobs, results retrieval, and health checks.
"""

import os
import json
import uuid
import shutil
from pathlib import Path
from typing import Optional
from datetime import datetime
from enum import Enum

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# Initialize FastAPI app
app = FastAPI(
    title="Medical CT Compression API",
    description="LLM-optimized compression for medical CT volumes",
    version="0.1.0",
)

# CORS middleware for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Job storage directory
JOBS_DIR = Path("./jobs")
JOBS_DIR.mkdir(exist_ok=True)


class JobStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETE = "complete"
    FAILED = "failed"


class CompressRequest(BaseModel):
    path: str
    generate_llm_bundle: bool = True


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    message: Optional[str] = None


class JobResult(BaseModel):
    status: JobStatus
    patient_id: Optional[str] = None
    metrics: Optional[dict] = None
    compressed_path: Optional[str] = None
    llm_bundle_path: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None


def get_job_dir(job_id: str) -> Path:
    """Get job directory path."""
    return JOBS_DIR / job_id


def save_job_status(job_id: str, status: dict):
    """Save job status to JSON file."""
    job_dir = get_job_dir(job_id)
    job_dir.mkdir(exist_ok=True)
    with open(job_dir / "status.json", "w") as f:
        json.dump(status, f, indent=2, default=str)


def load_job_status(job_id: str) -> Optional[dict]:
    """Load job status from JSON file."""
    status_file = get_job_dir(job_id) / "status.json"
    if status_file.exists():
        with open(status_file, "r") as f:
            return json.load(f)
    return None


def run_compression_job(job_id: str, input_path: str, generate_llm_bundle: bool = True):
    """
    Background task to run compression.
    """
    from dicom_io import load_ct_volume
    from compressor import compress_volume, decompress_volume, save_compressed, export_llm_bundle
    from metrics import calculate_compression_metrics
    
    job_dir = get_job_dir(job_id)
    
    try:
        # Update status to processing
        save_job_status(job_id, {
            "status": JobStatus.PROCESSING,
            "created_at": datetime.now().isoformat(),
        })
        
        # Load volume
        volume, metadata = load_ct_volume(input_path)
        original_bytes = volume.nbytes
        
        # Compress
        compressed_data, comp_stats = compress_volume(volume, metadata)
        
        # Save compressed
        compressed_path = job_dir / "compressed.npz"
        save_compressed(compressed_data, str(compressed_path))
        compressed_bytes = compressed_path.stat().st_size
        
        # Decompress for quality verification
        reconstructed, _ = decompress_volume(compressed_data)
        
        # Calculate metrics
        metrics = calculate_compression_metrics(
            volume, reconstructed,
            original_bytes, compressed_bytes,
            comp_stats["processing_time_sec"]
        )
        
        # Generate LLM bundle if requested
        llm_bundle_path = None
        if generate_llm_bundle:
            llm_dir = job_dir / "llm_bundle"
            export_llm_bundle(volume, metadata, str(llm_dir))
            llm_bundle_path = str(llm_dir)
        
        # Save final status
        save_job_status(job_id, {
            "status": JobStatus.COMPLETE,
            "patient_id": metadata.get("patient_id"),
            "metrics": metrics,
            "compressed_path": str(compressed_path),
            "llm_bundle_path": llm_bundle_path,
            "created_at": datetime.now().isoformat(),
            "completed_at": datetime.now().isoformat(),
        })
        
    except Exception as e:
        save_job_status(job_id, {
            "status": JobStatus.FAILED,
            "error": str(e),
            "created_at": datetime.now().isoformat(),
            "completed_at": datetime.now().isoformat(),
        })


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.1.0"}


@app.post("/compress", response_model=JobResponse)
async def start_compression(request: CompressRequest, background_tasks: BackgroundTasks):
    """
    Start a compression job for a patient folder.
    
    The job runs in the background. Use GET /result/{job_id} to check status.
    """
    # Validate path exists
    if not Path(request.path).exists():
        raise HTTPException(status_code=400, detail=f"Path not found: {request.path}")
    
    # Create job
    job_id = str(uuid.uuid4())
    
    # Initialize job status
    save_job_status(job_id, {
        "status": JobStatus.PENDING,
        "created_at": datetime.now().isoformat(),
    })
    
    # Queue background task
    background_tasks.add_task(
        run_compression_job, 
        job_id, 
        request.path,
        request.generate_llm_bundle
    )
    
    return JobResponse(
        job_id=job_id,
        status=JobStatus.PENDING,
        message="Compression job started"
    )


@app.post("/compress/upload", response_model=JobResponse)
async def upload_and_compress(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    generate_llm_bundle: bool = True
):
    """
    Upload a ZIP file containing DICOM files and start compression.
    """
    import zipfile
    import tempfile
    
    # Create job
    job_id = str(uuid.uuid4())
    job_dir = get_job_dir(job_id)
    job_dir.mkdir(exist_ok=True)
    
    # Save uploaded file
    upload_dir = job_dir / "upload"
    upload_dir.mkdir(exist_ok=True)
    
    try:
        # Save and extract ZIP
        zip_path = upload_dir / "upload.zip"
        with open(zip_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        extract_dir = upload_dir / "extracted"
        with zipfile.ZipFile(zip_path, 'r') as z:
            z.extractall(extract_dir)
        
        # Initialize job status
        save_job_status(job_id, {
            "status": JobStatus.PENDING,
            "created_at": datetime.now().isoformat(),
        })
        
        # Queue background task
        background_tasks.add_task(
            run_compression_job,
            job_id,
            str(extract_dir),
            generate_llm_bundle
        )
        
        return JobResponse(
            job_id=job_id,
            status=JobStatus.PENDING,
            message="Upload received, compression started"
        )
        
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid ZIP file")


@app.get("/result/{job_id}", response_model=JobResult)
async def get_result(job_id: str):
    """
    Get the status and results of a compression job.
    """
    status = load_job_status(job_id)
    
    if status is None:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return JobResult(**status)


@app.get("/bundle/{job_id}")
async def get_bundle(job_id: str):
    """
    Get the LLM bundle metadata for a completed job.
    
    Returns JSON with file paths. Use individual file endpoints to download.
    """
    status = load_job_status(job_id)
    
    if status is None:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if status.get("status") != JobStatus.COMPLETE:
        raise HTTPException(status_code=400, detail=f"Job not complete: {status.get('status')}")
    
    llm_bundle_path = status.get("llm_bundle_path")
    if not llm_bundle_path or not Path(llm_bundle_path).exists():
        raise HTTPException(status_code=404, detail="LLM bundle not found")
    
    # Read metadata.json
    metadata_path = Path(llm_bundle_path) / "metadata.json"
    if metadata_path.exists():
        with open(metadata_path, "r") as f:
            metadata = json.load(f)
    else:
        metadata = {}
    
    # List files in bundle
    files = [f.name for f in Path(llm_bundle_path).iterdir() if f.is_file()]
    
    return {
        "job_id": job_id,
        "bundle_path": llm_bundle_path,
        "files": files,
        "metadata": metadata,
    }


@app.get("/bundle/{job_id}/{filename}")
async def get_bundle_file(job_id: str, filename: str):
    """
    Download a specific file from the LLM bundle.
    """
    status = load_job_status(job_id)
    
    if status is None:
        raise HTTPException(status_code=404, detail="Job not found")
    
    llm_bundle_path = status.get("llm_bundle_path")
    if not llm_bundle_path:
        raise HTTPException(status_code=404, detail="LLM bundle not found")
    
    file_path = Path(llm_bundle_path) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    
    # Determine media type
    suffix = file_path.suffix.lower()
    media_types = {
        ".png": "image/png",
        ".json": "application/json",
        ".npz": "application/octet-stream",
    }
    media_type = media_types.get(suffix, "application/octet-stream")
    
    return FileResponse(file_path, media_type=media_type, filename=filename)


@app.get("/jobs")
async def list_jobs(limit: int = 20):
    """
    List recent compression jobs.
    """
    jobs = []
    
    for job_dir in sorted(JOBS_DIR.iterdir(), reverse=True)[:limit]:
        if job_dir.is_dir():
            status = load_job_status(job_dir.name)
            if status:
                jobs.append({
                    "job_id": job_dir.name,
                    "status": status.get("status"),
                    "patient_id": status.get("patient_id"),
                    "created_at": status.get("created_at"),
                })
    
    return {"jobs": jobs, "count": len(jobs)}


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    """
    Delete a job and its files.
    """
    job_dir = get_job_dir(job_id)
    
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found")
    
    shutil.rmtree(job_dir)
    
    return {"message": f"Job {job_id} deleted"}


# CLI entry point for running server
def run_server(host: str = "0.0.0.0", port: int = 8000):
    """Run the FastAPI server."""
    import uvicorn
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
