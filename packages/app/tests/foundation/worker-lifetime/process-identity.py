import ctypes
import json
import os
import sys


class Info(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint32)
        for name in [
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
            "rgid", "svuid", "svgid", "reserved",
        ]
    ] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32)
        for name in ["nfiles", "pgid", "pjobc", "tdev", "tpgid"]
    ] + [
        ("nice", ctypes.c_int32), ("startSec", ctypes.c_uint64),
        ("startUsec", ctypes.c_uint64),
    ]


lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pidinfo.argtypes = [
    ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int,
]
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]


def identify(pid):
    info = Info()
    count = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if count != ctypes.sizeof(info):
        return {"pid": pid, "found": False, "errno": ctypes.get_errno()}
    executable = ctypes.create_string_buffer(4096)
    lib.proc_pidpath(pid, executable, 4096)
    return {
        "pid": info.pid, "ppid": info.ppid, "uid": info.uid,
        "stamp": f"{info.startSec}:{info.startUsec}",
        "state": "Z" if info.status == 5 else str(info.status),
        "executable": os.fsdecode(executable.value), "found": True,
    }


destination = os.environ.get("OK_LIFETIME_IDENTITY_EVENTS")
if destination:
    with open(destination, "a") as stream:
        stream.write(json.dumps({
            "event": "sampler-start", "identity": identify(os.getpid()),
            "runId": os.environ["OK_LIFETIME_IDENTITY_RUN"],
        }) + "\n")

print(json.dumps([identify(int(value)) for value in sys.argv[1:]]))

if destination:
    with open(destination, "a") as stream:
        stream.write(json.dumps({
            "event": "sampler-settled", "pid": os.getpid(), "code": 0,
            "runId": os.environ["OK_LIFETIME_IDENTITY_RUN"],
        }) + "\n")
