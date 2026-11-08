"""python -m brain.assure [--real] [--learner all|reference|trainer] [--quick] [--bundle DIR] [--no-report]: exit 1 on a failure."""
from __future__ import annotations

import argparse
import json
import sys
import warnings

from brain.assure.suite import check_bundle, run, write_report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m brain.assure")
    ap.add_argument("--real", action="store_true", help="also run the checks that read the real data on the drive")
    ap.add_argument("--learner", default="all", help="all | reference | trainer")
    ap.add_argument("--quick", action="store_true", help="3 worlds instead of 5")
    ap.add_argument("--bundle", help="check a model bundle for promotion (what brain.gate calls)")
    ap.add_argument("--no-report", action="store_true")
    a = ap.parse_args(argv)
    warnings.filterwarnings("ignore")
    res = check_bundle(a.bundle) if a.bundle else run(real=a.real, learner=a.learner, quick=a.quick)
    for c in res["checks"]:
        state = "SKIP" if c["skipped"] else ("PASS" if c["passed"] else "FAIL")
        print(f"{state}  {c['name']}" + (f"  - {c['detail']}" if c["detail"] and state != "PASS" else ""))
    for w in res["warnings"]:
        print("WARN ", w)
    for m in res["missing"]:
        print("NOTE ", m)
    if not a.no_report:
        try:
            j, h = write_report(res)
            print("report:", h)
        except OSError as e:
            print("report not written:", e, file=sys.stderr)
    print(json.dumps({"passed": res["passed"], "failed": res["failed"], "runtime_s": res["runtime_s"],
                      **({"learning_verified": res["learning_verified"]} if "learning_verified" in res else {})}))
    ok = res["passed"] and (res.get("learning_verified", True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
