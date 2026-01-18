'use client';

import { useRef, useState, DragEvent, ChangeEvent } from 'react';

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  maxFiles?: number;
  maxSizeMB?: number;
}

export default function FileUpload({
  onFilesSelected,
  maxFiles = 50,
  maxSizeMB = 500,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFiles = (files: File[]): string | null => {
    if (files.length === 0) {
      return 'Please select at least one file.';
    }
    if (files.length > maxFiles) {
      return `Maximum ${maxFiles} files allowed.`;
    }

    const oversizedFiles = files.filter(
      (file) => file.size > maxSizeMB * 1024 * 1024
    );
    if (oversizedFiles.length > 0) {
      return `Some files exceed ${maxSizeMB}MB limit.`;
    }

    return null;
  };

  const handleFiles = (files: File[]) => {
    setError(null);
    const validationError = validateFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSelectedFiles(files);
    onFilesSelected(files);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    handleFiles(files);
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="w-full">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        className={`
          border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
          ${
            isDragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-gray-300 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500 bg-gray-50 dark:bg-gray-800/50'
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInput}
          className="hidden"
          accept=".dcm,.dicom,.nii,.nii.gz,.mhd,.raw,.img,.zip"
        />
        <div className="flex flex-col items-center gap-2">
          <div className="text-4xl mb-2">📁</div>
          <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
            Drag and drop scan files here
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            or click to browse
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            Supports: DICOM files (.dcm, .dicom), ZIP folders, NIfTI (.nii, .nii.gz), MHD (.mhd)
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Max {maxFiles} files, {maxSizeMB}MB per file
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {selectedFiles.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Selected Files ({selectedFiles.length})
          </h3>
          <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800">
            <ul className="space-y-1">
              {selectedFiles.map((file, index) => (
                <li
                  key={index}
                  className="text-sm text-gray-600 dark:text-gray-400 flex justify-between items-center"
                >
                  <span className="truncate flex-1">{file.name}</span>
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-500">
                    {formatFileSize(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
