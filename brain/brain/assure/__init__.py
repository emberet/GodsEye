"""
brain.assure: the research report's findings (research-2026-11-06) as checks the brain must keep passing.

  worlds     synthetic markets with a planted truth, in the shapes brain.sim consumes (the real simulator runs on them)
  features   point-in-time features of a world (insert-time rule), plus a brute-force reference and a leaky mutant
  artifacts  one check per measurement artifact the report found (dead coins, exit timing, stops, fees, calibration,
             insert time, stacking): none of them may come back
  learning   learner-agnostic "does it learn" checks (null world, veto, edge, traps, leak canary, learning curve, seeds,
             regime shift, stress, kappa, stakes, fine-tuning on paper transitions)
  reference  a small bootstrapped-ensemble learner that proves the checks can be passed (not a product model)

    python -m brain.assure            # the worlds suite -> <DATA>/reports/assure-YYYY-MM-DD.{json,html}; exit 1 on a failure
    python -m brain.assure --real     # + the artifact checks on the real data on the drive (read-only)

Paper money only: nothing here reaches the server, the real copy engine or a wallet.
"""
