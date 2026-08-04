"""Feishu Bitable (多维表格) integration: schema constants + record batch operations.

APIs (verified 2026-08):
- List tables:     GET  /bitable/v1/apps/{app_token}/tables
- Search records:  POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/search
- Batch create:    POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create
- Batch update:    POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_update

Field type codes (write format):
- text = 1, number = 2, single select = 3, multi select = 4,
  date = 5 (ms timestamp), checkbox = 7, person = 11 (open_id)
- single select value: {"text": "..."}; multi select value: [{"text": "..."}]
"""

from typing import Any, Optional

from .client import FeishuClient

FIELD_TEXT = 1
FIELD_NUMBER = 2
FIELD_SINGLE_SELECT = 3
FIELD_MULTI_SELECT = 4
FIELD_DATE = 5
FIELD_CHECKBOX = 7
FIELD_PERSON = 11

# Suggested table schemas (field name -> field type). Build these in the Feishu
# console first, then fill FEISHU_BITABLE_TABLE_IDS in .env.
TABLE_COURSES = {
    "班级名": FIELD_TEXT,
    "年级": FIELD_NUMBER,
    "创建时间": FIELD_DATE,
}

TABLE_TOPICS = {
    "标题": FIELD_TEXT,
    "类型": FIELD_SINGLE_SELECT,
    "认知梯段": FIELD_SINGLE_SELECT,
    "引导材料": FIELD_TEXT,
    "参考论据": FIELD_TEXT,
    "顺序": FIELD_NUMBER,
}

TABLE_STUDENTS = {
    "姓名": FIELD_TEXT,
    "年级": FIELD_NUMBER,
    "认知梯段": FIELD_SINGLE_SELECT,
    "班级": FIELD_TEXT,
    "评语草稿": FIELD_TEXT,
}

TABLE_RESPONSES = {
    "学生": FIELD_TEXT,
    "辩题": FIELD_TEXT,
    "来源": FIELD_SINGLE_SELECT,
    "原始文本": FIELD_TEXT,
    "清洗文本": FIELD_TEXT,
    "AI评分摘要": FIELD_TEXT,
    "AI置信度": FIELD_SINGLE_SELECT,
    "AI建议标签": FIELD_MULTI_SELECT,
    "教师评分": FIELD_TEXT,
    "教师标签": FIELD_MULTI_SELECT,
    "教师批注": FIELD_TEXT,
    "状态": FIELD_SINGLE_SELECT,
    "更新时间": FIELD_DATE,
}


class BitableService:
    def __init__(
        self,
        client: FeishuClient,
        app_token: str = "",
        table_ids: Optional[dict] = None,
    ) -> None:
        self.client = client
        self.app_token = app_token or client.config.bitable_app_token
        self.table_ids = table_ids or client.config.bitable_table_ids

    def _base(self, table_id: str) -> str:
        return f"/bitable/v1/apps/{self.app_token}/tables/{table_id}"

    async def list_tables(self) -> Any:
        """List tables of the configured app (useful to look up table_ids)."""
        return await self.client.request(
            "GET", f"/bitable/v1/apps/{self.app_token}/tables", params={"page_size": 100}
        )

    async def search_records(
        self,
        table_id: str,
        page_size: int = 500,
        page_token: str = "",
        filter_spec: Optional[dict] = None,
    ) -> Any:
        body: dict = {"page_size": page_size}
        if page_token:
            body["page_token"] = page_token
        if filter_spec:
            body["filter"] = filter_spec
        return await self.client.request(
            "POST", f"{self._base(table_id)}/records/search", json_body=body
        )

    async def batch_create_records(self, table_id: str, records: list[dict]) -> Any:
        """records: [{"fields": {...}}, ...] (max 1000 per call)."""
        return await self.client.request(
            "POST", f"{self._base(table_id)}/records/batch_create", json_body={"records": records}
        )

    async def batch_update_records(self, table_id: str, records: list[dict]) -> Any:
        """records: [{"record_id": "...", "fields": {...}}, ...] (max 500 per call)."""
        return await self.client.request(
            "POST", f"{self._base(table_id)}/records/batch_update", json_body={"records": records}
        )
