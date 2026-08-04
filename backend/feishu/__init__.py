"""Feishu Open Platform integration (minutes / bitable / bot).

See 飞书集成技术方案.md for the overall design.
"""

from .client import FeishuClient, FeishuConfig, FeishuAPIError

__all__ = ["FeishuClient", "FeishuConfig", "FeishuAPIError"]
