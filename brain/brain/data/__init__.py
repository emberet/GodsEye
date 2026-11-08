"""Data access for the brain research: duckdb views over the export (`connect`) and the derived datasets (`derive`)."""
from brain.data.loaders import connect, data_dir, derived_dir, export_dir

__all__ = ["connect", "data_dir", "derived_dir", "export_dir"]
