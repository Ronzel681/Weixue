import json
import unittest

import httpx

from feishu.client import FeishuClient


class FeishuClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_tenant_token_is_cached(self):
        calls = {"auth": 0}

        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/auth/v3/tenant_access_token/internal/")
            calls["auth"] += 1
            body = json.loads(request.content.decode())
            self.assertEqual(body["app_id"], "cli_test")
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "msg": "success",
                    "tenant_access_token": "t-test-token",
                    "expire": 7200,
                },
            )

        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(transport=transport, base_url="https://example.test")
        client = FeishuClient(
            "cli_test",
            "secret",
            base_url="https://example.test",
            http_client=http,
        )
        try:
            first = await client.get_tenant_access_token()
            second = await client.get_tenant_access_token()
            self.assertEqual(first, "t-test-token")
            self.assertEqual(second, first)
            self.assertEqual(calls["auth"], 1)
        finally:
            await http.aclose()

    async def test_transcript_export_uses_bearer_token(self):
        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/tenant_access_token/internal/"):
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "msg": "success",
                        "tenant_access_token": "t-test-token",
                        "expire": 7200,
                    },
                )
            self.assertEqual(request.headers["Authorization"], "Bearer t-test-token")
            self.assertEqual(
                request.url.path,
                "/minutes/v1/minutes/obcn12345678901234567890/transcript",
            )
            return httpx.Response(200, content="说话人1：测试文本".encode("utf-8"))

        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(transport=transport, base_url="https://example.test")
        client = FeishuClient(
            "cli_test",
            "secret",
            base_url="https://example.test",
            http_client=http,
        )
        try:
            transcript = await client.export_minute_transcript("obcn12345678901234567890")
            self.assertIn("测试文本", transcript)
        finally:
            await http.aclose()

    async def test_unconfigured_health_is_explicit(self):
        client = FeishuClient(http_client=httpx.AsyncClient())
        try:
            result = await client.health_check()
            self.assertEqual(result["status"], "not_configured")
            self.assertFalse(result["auth"])
        finally:
            await client._http.aclose()


if __name__ == "__main__":
    unittest.main()
