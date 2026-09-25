# One of the things the desk asks the tool for most: arithmetic it does not
# want to do in its own head.
import statistics

amounts = [18240.50, 21105.00, 19870.25, 22410.75, 17655.00, 24980.50]

print("TOTAL", round(sum(amounts), 2))
print("MEAN", round(statistics.mean(amounts), 2))
print("SPREAD", round(max(amounts) - min(amounts), 2))
