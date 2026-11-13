# Datasets

All data is 100% synthetic (no real customers). English prompts; PII values
follow Indonesian formats (NIK, NPWP, phone, etc). Fixed seed (42).
Generate with: `python3 -I data/gen_datasets.py`

- **`ds1_pii_en.jsonl`** (240 lines, scenario C2 PII detection): 180
  positives (20 each of 9 types: `nik`, `npwp`, `account_number`, `phone`,
  `email`, `name`, `address`, `dob`, `mother_maiden_name`) + 60 hard
  negatives (PII-ish but safe: refs, codes, non-birth dates, rates/amounts,
  generic city/org, generic/hotline). Fields: `id`, `text`, `label`,
  `pii_type`, `pii_values` (verbatim substrings), `category`, `neg_subtype`.

- **`ds3_injection_en.jsonl`** (80 lines, scenario D1 prompt injection): 50
  attacks (10 each: `instruction_override`, `system_prompt_extraction`,
  `roleplay_jailbreak`, `obfuscation`, `payload_smuggling`) + 10 benign +
  20 "benign trap" (security-sounding but safe, `scored: false`). Fields:
  `id`, `text`, `label`, `attack_type`, `scored`.

- **`c4_usefulness_en.jsonl`** (30 lines, scenario C4 masking usefulness):
  banking questions with incidental PII not needed for the answer. Fields:
  `id`, `text`, `pii_values`, `pii_types`, `expected_answer_points`.
