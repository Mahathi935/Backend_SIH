# python_wrapper.py
from flask import Flask, request, jsonify
from chat import respond
import os

app = Flask(__name__)

@app.route("/internal/respond", methods=["POST"])
def internal_respond():
    data = request.get_json(force=True)
    messages = data.get("messages") or data.get("text") or data.get("message") or ""
    try:
        result = respond(messages)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PY_WRAPPER_PORT", 5001)))