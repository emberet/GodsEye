"""The PRIVATE social model: a wallet's next-14-day copy return predicted from what its X account(s) post.

    features.py  the social inputs of brain/spec/features.yaml (`social.inputs`), point in time, as pure functions
    data.py      loads the private social tables, the wallets' first buys and the copy outcomes the target is built on
    train.py     `python -m brain.social.train`: dataset, a small MLP, social.onnx + manifest.json (CONTRACT.md "Social score")
    golden.py    writes golden.json, the input -> vector cases the TypeScript scorer (agent/src/social/score.ts) reproduces

Nothing here is published: bundles and logs stay under PRIVATE_DIR, and logs carry counts only (never a wallet or a handle).
"""
