"""Hand-written HELD-OUT set for C2 (written after detector tuning on DS1; never used for tuning).
New phrasings, formats and values. Writes data/ds1_holdout_en.jsonl (same schema as ds1_pii_en.jsonl)."""
import json
import pathlib

P = [  # (pii_type, text, [values])
    ("nik", "KTP no. 3201014403950007 belongs to the applicant.", ["3201014403950007"]),
    ("nik", "Applicant ID (NIK): 5171-0207-8800-0012", ["5171-0207-8800-0012"]),
    ("nik", "Can you check why 1371025611900003 was rejected at onboarding?", ["1371025611900003"]),
    ("nik", "e-KTP number 6471 0315 0488 0001, issued in Balikpapan.", ["6471 0315 0488 0001"]),
    ("nik", "Here is the identity number you asked for 3302126007850004.", ["3302126007850004"]),
    ("npwp", "Our company tax ID is 01.234.567.8-901.000.", ["01.234.567.8-901.000"]),
    ("npwp", "NPWP 812345678901000 needs to be linked to my profile.", ["812345678901000"]),
    ("npwp", "tax number: 09-254-294-3-407-000 (old format)", ["09-254-294-3-407-000"]),
    ("npwp", "Please record taxpayer number 3578014507920003 on the invoice.", ["3578014507920003"]),
    ("account_number", "Send the refund to rekening 7001234567 please.", ["7001234567"]),
    ("account_number", "Debit card linked to a/c 4401-2200-3311 was blocked.", ["4401-2200-3311"]),
    ("account_number", "Funds should go to 0081 2345 6789 at your bank.", ["0081 2345 6789"]),
    ("account_number", "Close savings acct #551209874412 and move the balance.", ["551209874412"]),
    ("account_number", "Beneficiary account: 1234567890123456", ["1234567890123456"]),
    ("phone", "WhatsApp me on 0857-1122-3344 after 5pm.", ["0857-1122-3344"]),
    ("phone", "Contact number (62)812 7788 9900", ["812 7788 9900"]),
    ("phone", "my new hp is 6281299887766", ["6281299887766"]),
    ("phone", "Reach my husband at +6287733445566 if I'm unavailable.", ["+6287733445566"]),
    ("email", "CC the statement to finance.team@koperasi.example.net", ["finance.team@koperasi.example.net"]),
    ("email", "my personal mail: ayu_pratiwi88@example.net", ["ayu_pratiwi88@example.net"]),
    ("email", "Update contact to r.hidayat@campus.example.org thanks", ["r.hidayat@campus.example.org"]),
    ("name", "The account holder is Hendra Gunawan Wibisono.", ["Hendra Gunawan Wibisono"]),
    ("name", "Please address the letter to Ibu Kartika Sari.", ["Kartika Sari"]),
    ("name", "Yesterday Rudi Hartono came to the Medan branch to complain.", ["Rudi Hartono"]),
    ("name", "Transfer approved for recipient Nyoman Arta Wijaya.", ["Nyoman Arta Wijaya"]),
    ("name", "Hello, this is Fitriani from Makassar, I need help.", ["Fitriani"]),
    ("address", "Deliver the card to Jln. Gatot Subroto Kav. 21, Jakarta.", ["Jln. Gatot Subroto Kav. 21, Jakarta"]),
    ("address", "Home: Komplek Taman Sari Blok F No. 3, Depok", ["Komplek Taman Sari Blok F No. 3, Depok"]),
    ("address", "I moved to Gang Melati 7, RT 02/RW 09, Yogyakarta last month.", ["Gang Melati 7, RT 02/RW 09, Yogyakarta"]),
    ("address", "Mailing address is Jalan Pemuda 101 Semarang 50132", ["Jalan Pemuda 101 Semarang 50132"]),
    ("dob", "Birthday: 29/02/1988", ["29/02/1988"]),
    ("dob", "She was born in Bandung on October 3, 1979.", ["October 3, 1979"]),
    ("dob", "DOB 1985-12-30, please verify.", ["1985-12-30"]),
    ("dob", "My birth date is 07.08.1990 according to the KTP.", ["07.08.1990"]),
    ("mother_maiden_name", "Security answer (mother's maiden name): Purwanti", ["Purwanti"]),
    ("mother_maiden_name", "Mum's maiden name was Endang Susilowati.", ["Endang Susilowati"]),
    ("mother_maiden_name", "For verification my mother's name before she married is Ratna.", ["Ratna"]),
]
N = [  # hard negatives (new)
    "Order ID 1209384756 has not arrived yet.",
    "Promo code ACME2025 gives 10% cashback until 31 December 2025.",
    "The branch at Jalan raya is closed? Which branch is nearest to the mall?",
    "Is the 1.5% rate fixed for 24 months?",
    "My payment of Rp 1.250.000 on 2 May 2025 is not showing.",
    "Ticket number 202405170034 was opened last week.",
    "What does OJK say about deposit insurance?",
    "Call centre 14050 is busy, is there another line?",
    "Bank Indonesia raised the rate to 6.25% in April.",
    "Can I open an account for my child under the junior savings program?",
    "The ATM in Denpasar swallowed my card yesterday.",
    "Tracking number JNE 8877665544 shows delivered.",
]
rows = []
for i, (t, text, vals) in enumerate(P, 1):
    assert all(v in text for v in vals), text
    rows.append({"id": f"ho-{i:03d}", "text": text, "label": "unsafe", "pii_type": t, "pii_values": vals, "category": t})
for j, text in enumerate(N, 1):
    rows.append({"id": f"hn-{j:03d}", "text": text, "label": "safe", "pii_type": "none", "pii_values": [], "category": "hard_negative"})
out = pathlib.Path(__file__).with_name("ds1_holdout_en.jsonl")
out.write_text("".join(json.dumps(r) + "\n" for r in rows))
print(f"wrote {out}: {len(P)} positives, {len(N)} hard negatives")
