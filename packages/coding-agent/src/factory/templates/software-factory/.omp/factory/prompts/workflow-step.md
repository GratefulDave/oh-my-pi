Software-factory workflow step.

Original request:

$ORIGINAL

Prior step output:

$INPUT

Produce output another agent can consume without guessing.

Requirements:
- Use repo-local factory assets when relevant.
- Keep outputs reusable by later steps.
- Report explicit risks, assumptions, and missing oracles.
- Do not silently skip verification boundaries.
- If you define a repeatable pattern, say which `.omp/factory/*` asset should capture it.
- Prefer compact structured sections such as:
  - Facts
  - Plan / Implementation
  - Risks
  - Verification
  - Template changes