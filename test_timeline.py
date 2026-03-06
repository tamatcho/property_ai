import requests

try:
    resp = requests.post("http://127.0.0.1:8000/timeline/extract", json={"raw_text": "Frist für die Zahlung ist der 15.01.2026. Bitte überweisen Sie 500 Euro."})
    print(resp.status_code)
    print(resp.json())
except Exception as e:
    print(e)
