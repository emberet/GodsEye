def pytest_configure(config):
    config.addinivalue_line("markers", "learning: the brain.assure learning checks (minutes; deselect with -m 'not learning')")
