import requests
import time
from datetime import datetime
import threading
from concurrent.futures import ThreadPoolExecutor

uid = "FEe6qKyrn2"
uid2 = "j8EYENJLH2"
uid3 = "KaecvaKob2"

def send_message(uid, message, number):
    start_time = time.time()
    
    # url = 'http://44.214.108.8:3000/send-message'
    url = 'http://localhost:3001/send-message'
    headers = {'Authorization': f"Bearer {uid}"}
    data = {'message': message, 'number': number}

    response = requests.post(url, headers=headers, json=data)
    
    end_time = time.time()
    execution_time = end_time - start_time
    
    print(f"Thread: {threading.current_thread().name}")
    print(f"Response for UID {uid}: {response.text}")
    print(f"Execution time: {execution_time:.2f} seconds")
    print(f"Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

# List of message tasks
message_tasks = [
    (uid, "testing12", "923237146391"),
    (uid2, "testing123", "923237146391"),
    (uid3, "testing123", "923237146391"),
    # (uid, "testing12", "923237146391"),
    # (uid2, "testing123", "923237146391"),
    # (uid3, "testing123", "923237146391"),
    # (uid, "testing123", "923237146391"),
    # (uid2, "testing123", "923237146391"),
    # (uid3, "testing123", "923237146391"),
    # (uid, "testing123", "923237146391"),
    # (uid2, "testing123", "923237146391"),
    # (uid3, "testing123", "923237146391"),
    
]

# Using ThreadPoolExecutor to manage threads
start_total = time.time()

with ThreadPoolExecutor(max_workers=3) as executor:
    # Submit all tasks
    futures = [executor.submit(send_message, *task) for task in message_tasks]

end_total = time.time()
total_time = end_total - start_total

print(f"All messages sent!")
print(f"Total execution time: {total_time:.2f} seconds")