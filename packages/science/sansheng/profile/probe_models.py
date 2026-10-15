# Probe tool-calling support of USTC gateway models. Key from env only.
import json, os, sys, time, urllib.request

BASE = "https://api.llm.ustc.edu.cn/v1/chat/completions"
KEY = os.environ["USTC_LLM_API_KEY"]
TOOL = {"type": "function", "function": {
    "name": "read_file", "description": "Read a file from the workspace",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}

def call(model, body):
    req = urllib.request.Request(BASE, data=json.dumps({"model": model, **body}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r), time.time() - t

def probe(model):
    msgs = [{"role": "user", "content": "Read the file topics/001/02-plan.md and tell me its title."}]
    try:
        d, dt = call(model, {"messages": msgs, "tools": [TOOL], "max_tokens": 1024})
    except Exception as e:
        return f"{model}: ERROR {getattr(e, 'code', '')} {str(e)[:150]}"
    m = d["choices"][0]["message"]
    tc = m.get("tool_calls") or []
    if not tc:
        return f"{model}: NO tool call ({dt:.1f}s) content={str(m.get('content'))[:80]!r}"
    c = tc[0]
    args = c["function"]["arguments"]
    # round 2: feed tool result back, check it can continue
    msgs += [m, {"role": "tool", "tool_call_id": c["id"], "content": "# 晶格热导率的机器学习预测\n..."}]
    try:
        d2, dt2 = call(model, {"messages": msgs, "tools": [TOOL], "max_tokens": 1024})
        ans = str(d2["choices"][0]["message"].get("content"))[:60]
    except Exception as e:
        ans = f"ROUND2 ERROR {str(e)[:100]}"
    return f"{model}: tool={c['function']['name']} args={args} ({dt:.1f}s) | round2 ({dt2 if 'dt2' in dir() else 0:.1f}s): {ans!r}"

for m in sys.argv[1:]:
    print(probe(m), flush=True)
