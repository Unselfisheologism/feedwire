import os
from fastapi import FastAPI
from feedwire import create_feedback_router

app = FastAPI()
app.include_router(create_feedback_router(
    db_path=os.environ.get("FEEDBACK_DB", "feedback.db"),
    admin_token=os.environ.get("FEEDBACK_ADMIN_TOKEN"),
))


@app.get("/users")
def users():
    return []
