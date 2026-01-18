# Medical CT Compression Pipeline

LLM-optimized compression for medical CT volumes. Achieves 80%+ token savings while maintaining diagnostic quality.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Compress a CT scan
python main.py compress ./LIDC-IDRI-0001 ./output

# View report without compressing
python main.py report ./LIDC-IDRI-0001

# Generate LLM-friendly bundle (PNGs + JSON)
python main.py export-llm ./LIDC-IDRI-0001 ./llm-bundle

# Start API server
python main.py serve --port 8000
```

## Features

- **6:1+ compression ratio** with PSNR >40dB, SSIM >0.95
- **Classical methods only** - no ML training required
- **<30 second processing** on CPU for typical 500MB scan
- **LLM-friendly export** with representative slices and metadata
- **FastAPI backend** for integration

## CLI Commands

| Command | Description |
|---------|-------------|
| `compress <input> <output>` | Compress CT volume |
| `decompress <file> <output>` | Decompress and verify |
| `report <input>` | Show volume stats and cost |
| `export-llm <input> <output>` | Generate LLM bundle |
| `evaluate <dir> [--labels csv]` | Run evaluation harness |
| `serve [--port N]` | Start API server |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/compress` | Start compression job |
| GET | `/result/{job_id}` | Get job status/results |
| GET | `/bundle/{job_id}` | Get LLM bundle |
| GET | `/health` | Health check |

API docs at `http://localhost:8000/docs` when server is running.

## Compression Pipeline

1. **Load DICOM** - Auto-select axial CT series, sort by Z-position
2. **Crop** - Remove air/background outside body
3. **Delta encode** - Store inter-slice differences sparsely
4. **Pack** - Save as compressed .npz

## Output Structure

```
output/
├── scan.npz          # Compressed volume
├── metrics.json      # Quality metrics
└── llm_bundle/       # LLM-friendly export
    ├── slice_00_top.png
    ├── slice_01_upper.png
    ├── ...
    ├── montage_overview.png
    └── metadata.json
```

## Requirements

- Python 3.9+
- pydicom, numpy, scipy, scikit-image, pillow
- fastapi, uvicorn (for API)

## Data Citation

Fedorov, A., Hancock, M., Clunie, D., Brockhhausen, M., Bona, J., Kirby, J., Freymann, J., Aerts, H.J.W.L., Kikinis, R., Prior, F. (2018). Standardized representation of the TCIA LIDC-IDRI annotations using DICOM. The Cancer Imaging Archive. https://doi.org/10.7937/TCIA.2018.h7umfurq

Armato III, S. G., McLennan, G., Bidaut, L., McNitt-Gray, M. F., Meyer, C. R., Reeves, A. P., Zhao, B., Aberle, D. R., Henschke, C. I., Hoffman, E. A., Kazerooni, E. A., MacMahon, H., Van Beek, E. J. R., Yankelevitz, D., Biancardi, A. M., Bland, P. H., Brown, M. S., Engelmann, R. M., Laderach, G. E., Max, D., Pais, R. C. , Qing, D. P. Y. , Roberts, R. Y., Smith, A. R., Starkey, A., Batra, P., Caligiuri, P., Farooqi, A., Gladish, G. W., Jude, C. M., Munden, R. F., Petkovska, I., Quint, L. E., Schwartz, L. H., Sundaram, B., Dodd, L. E., Fenimore, C., Gur, D., Petrick, N., Freymann, J., Kirby, J., Hughes, B., Casteele, A. V., Gupte, S., Sallam, M., Heath, M. D., Kuhn, M. H., Dharaiya, E., Burns, R., Fryd, D. S., Salganicoff, M., Anand, V., Shreter, U., Vastagh, S., Croft, B. Y., Clarke, L. P. (2015). Data From LIDC-IDRI [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX
