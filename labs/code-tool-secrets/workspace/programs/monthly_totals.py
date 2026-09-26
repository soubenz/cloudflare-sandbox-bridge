# Reads a file the caller placed in the working directory, and writes one
# back. Run it with:
#
#     python3 run_tool.py --input data/sales.csv programs/monthly_totals.py
#
# The tool copies sales.csv in, the program reads it from the directory it was
# started in, and whatever it writes there comes back as the run's output.
import csv
import json
from collections import defaultdict

totals = defaultdict(float)
with open("sales.csv", newline="") as handle:
    for row in csv.DictReader(handle):
        totals[row["month"]] += float(row["amount"])

for month in sorted(totals):
    print("MONTH", month, round(totals[month], 2))

with open("totals.json", "w") as handle:
    json.dump({m: round(v, 2) for m, v in sorted(totals.items())}, handle, indent=2)

print("WROTE totals.json")
