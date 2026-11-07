# 其他语言调用示例

非 DSH 语言怎么通过 REST/MCP 使用记忆。

## 其他语言调用示例

### Python（REST）

```python
import requests

BASE = "http://127.0.0.1:7337"

requests.post(f"{BASE}/api/memories", json={
    "content": "用户偏好深色主题。",
    "kind": "persona",
    "importance": 8,
    "tags": ["ui"],
}).raise_for_status()

hits = requests.get(f"{BASE}/api/memories/search", params={"q": "主题偏好", "limit": 3}).json()
for memory in hits["memories"]:
    print(memory["kind"], memory["content"], "|", memory["why"])
```

### Go

```go
body := strings.NewReader(`{"content":"用户的时区是 Asia/Shanghai。","kind":"persona","importance":9}`)
resp, err := http.Post("http://127.0.0.1:7337/api/memories", "application/json", body)
// ...
resp, err = http.Get("http://127.0.0.1:7337/api/memories/search?q=" + url.QueryEscape("时区"))
```

### PHP

```php
$ctx = stream_context_create(['http' => [
  'method'  => 'POST',
  'header'  => "content-type: application/json\r\n",
  'content' => json_encode(['content' => '用户喜欢喝拿铁。', 'kind' => 'persona']),
]]);
file_get_contents('http://127.0.0.1:7337/api/memories', false, $ctx);
```

### 任意 MCP 客户端

用官方 SDK 建立 stdio 连接后：

```text
tools/call  memory_add     {"content":"...","kind":"episodic"}
tools/call  memory_search  {"query":"...","limit":5}
```

MCP 客户端的模型不需要知道 SQLite 或本项目内部结构，只需要这 8 个工具。
