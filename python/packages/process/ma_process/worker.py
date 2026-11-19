"""Exec entry point. The startup file is private, trusted and never persisted."""

import asyncio
import os
import socket
import sys

import cloudpickle

from . import child_main


def main():
    sock = socket.socket(fileno=int(sys.argv[1]))
    with os.fdopen(int(sys.argv[2]), "rb") as bootstrap:
        # Resolve the embedding application's installed modules before unpickling.
        import pickle

        paths = pickle.load(bootstrap)
        sys.path[:] = paths
        plugin = cloudpickle.load(bootstrap)
    if os.getenv("MA_OFFLINE_TEST") == "1":

        def refuse(*args, **kwargs):
            raise AssertionError("Offline plugin must not connect to a network")

        socket.socket.connect = socket.socket.connect_ex = refuse
    asyncio.run(child_main(plugin, sock))


if __name__ == "__main__":
    main()
