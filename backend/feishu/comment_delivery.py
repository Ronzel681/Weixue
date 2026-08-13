"""Reliable, per-student Feishu delivery for teacher-approved comments."""

from datetime import datetime
from typing import Optional

from database import SessionLocal, Student

from .bot import BotService
from .client import FeishuClient, FeishuConfig


async def deliver_student_comment(
    student_id: int,
    expected_hash: str,
    client: Optional[FeishuClient] = None,
) -> None:
    """Deliver the reserved draft and persist success/failure for UI feedback.

    ``expected_hash`` prevents a queued task from sending a draft that the
    teacher edited after clicking the card button.
    """
    owns_client = client is None
    if client is None:
        client = FeishuClient(FeishuConfig())

    db = SessionLocal()
    try:
        student = db.get(Student, student_id)
        if not student:
            return
        if (
            student.comment_delivery_status != "sending"
            or student.comment_delivery_hash != expected_hash
        ):
            return

        open_id = (student.feishu_open_id or "").strip()
        comment = (student.comment_draft or "").strip()
        name = student.name
        if not open_id or not comment:
            student.comment_delivery_status = "failed"
            student.comment_delivery_error = "学生账号未绑定或评语为空"
            db.commit()
            return

        card = BotService.build_student_comment_card(
            student_name=name,
            comment=comment,
        )
        try:
            await BotService(client).send_card(open_id, card)
        except Exception as exc:
            db.refresh(student)
            if student.comment_delivery_hash == expected_hash:
                student.comment_delivery_status = "failed"
                student.comment_delivery_error = str(exc)[:500]
                student.comment_delivered_at = None
                db.commit()
            return

        db.refresh(student)
        if student.comment_delivery_hash == expected_hash:
            student.comment_delivery_status = "delivered"
            student.comment_delivery_error = ""
            student.comment_delivered_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
        if owns_client:
            await client.close()
