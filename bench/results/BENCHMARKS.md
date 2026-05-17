# TensorShield benchmark results

| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| altoro-mutual | 15 | 3 | 2 | 13 | 1 | 67% | 13% | 22% |

## altoro-mutual

**Covered (true positives)**

- altoro-xss-reflected
- altoro-param-tampering

**Uncovered (false negatives)**

- altoro-sqli-login
- altoro-sqli-search
- altoro-xss-stored
- altoro-lfi-content
- altoro-default-creds
- altoro-http-banking
- altoro-info-disclosure-comment
- altoro-info-disclosure-robots
- altoro-server-banner
- altoro-missing-x-frame
- altoro-missing-csp
- altoro-http-trace
- altoro-csrf-transfer

**Extras (findings not in ground truth — 1 total, first 20)**

- Business Logic Flaw: Negative Amount Transfer
