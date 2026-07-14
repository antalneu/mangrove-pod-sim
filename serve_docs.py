"""
serve_docs.py
=============
Serve the static docs/ site (the fully client-side, in-browser build) locally on
a robust WSGI server. Handy for previewing exactly what GitHub Pages will serve.

    .venv\\Scripts\\python serve_docs.py     # -> http://127.0.0.1:8010

(Python's built-in http.server can stall on the larger geometry file behind some
proxies; waitress serves it cleanly.)
"""
import os

from flask import Flask, send_from_directory

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")
# static_folder=None so Flask's reserved /static/ route doesn't shadow docs/static/*
app = Flask(__name__, static_folder=None)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@app.route("/")
def index():
    return send_from_directory(DOCS, "index.html")


@app.route("/<path:path>")
def any_file(path):
    return send_from_directory(DOCS, path)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8010))
    print(f"\n  Static docs preview -> http://127.0.0.1:{port}\n")
    try:
        from waitress import serve
        serve(app, host="127.0.0.1", port=port, threads=8)
    except ImportError:
        app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
