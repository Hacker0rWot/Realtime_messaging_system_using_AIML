import requests

# Replace with the path to your test image
image_path = "sample.jpg"

# FastAPI detection endpoint
url = "http://localhost:7001/detect"

# Open image in binary mode
with open(image_path, "rb") as f:
    files = {"file": f}
    response = requests.post(url, files=files)

# Print JSON response from server
print("Detection results:")
print(response.json())

