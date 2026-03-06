import os
import sys
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ.get("OPENAI_API_KEY")
model = os.environ.get("OPENAI_MODEL")

print(f"Testing api_key={api_key[:10]}... model={model}")

try:
    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Hello world"}],
        max_tokens=5
    )
    print("Success!", response.choices[0].message.content)
except Exception as e:
    print("Error:", str(e))
