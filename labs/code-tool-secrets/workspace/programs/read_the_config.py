# This is the program from the incident, kept so that the incident can be
# reproduced rather than argued about.
#
# Somebody asked the desk to "read the config and tell me what's in it". This
# is what the desk wrote, and the tool ran it, and it worked.
import os

path = os.environ.get("AGENT_CONFIG", "/workspace/config/credentials.ini")
print("reading", path)
print(open(path).read())

print("and the environment it was handed:")
for name in sorted(os.environ):
    if any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "DSN")):
        print(" ", name, "=", os.environ[name])
