"""Live API check with a bounded DATA-only executor, not an arbitrary shell."""
import json
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORK = ROOT / 'smoke-workspace'


def main():
    WORK.mkdir(exist_ok=True)
    nonce = 'LOCAL_PROOF_' + secrets.token_hex(10)
    (WORK / 'challenge.txt').write_text(nonce, encoding='utf-8')
    env = dict(line.split('=', 1) for line in (ROOT / '.arena-gui/.env').read_text().splitlines() if '=' in line)
    tools = [
        {'type': 'function', 'function': {'name': 'read_file', 'description': 'Read UTF-8 text from a local file.',
            'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}}},
        {'type': 'function', 'function': {'name': 'write_file', 'description': 'Write UTF-8 text to a local file.',
            'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}, 'content': {'type': 'string'}},
                           'required': ['path', 'content']}}},
    ]
    messages = [{'role': 'user', 'content':
        '这是本地工具测试。必须依次：用read_file读取 ' + str(WORK / 'challenge.txt') +
        '；用write_file把读到的全部内容原样写入 ' + str(WORK / 'result.txt') +
        '；再用read_file读回result.txt核对，最终回复验证码和是否一致。不要使用Arena自己的工具，不要猜测内容。'}]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    trace = []
    for turn in range(6):
        body = {'model': 'agent', 'stream': False, 'messages': messages, 'tools': tools}
        req = urllib.request.Request('http://127.0.0.1:20140/v1/chat/completions',
            data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + env['ARENA_AGENT_BRIDGE_KEY'],
            'Content-Type': 'application/json', 'x-codex-session-id': 'arena-bridge-bounded-tool-check'})
        start = time.monotonic()
        try:
            with opener.open(req, timeout=150) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as response:
            trace.append({'turn': turn, 'http_status': response.code, 'body': json.load(response)})
            break
        except Exception as error:
            trace.append({'turn': turn, 'error': type(error).__name__, 'detail': str(error)})
            break
        msg = payload['choices'][0]['message']
        trace.append({'turn': turn, 'seconds': round(time.monotonic()-start, 2), 'message': msg})
        messages.append(msg)
        calls = msg.get('tool_calls') or []
        print('TURN', turn, 'TOOL_CALLS', len(calls), flush=True)
        if not calls:
            break
        for call in calls:
            fn = call['function'];args = json.loads(fn['arguments'])
            requested = Path(args['path'])
            p = (requested if requested.is_absolute() else WORK / requested).resolve()
            if p.parent != WORK.resolve() or p.name not in ('challenge.txt', 'result.txt'):
                answer = {'error': 'Outside the test grant'}
            elif fn['name'] == 'read_file':
                answer = {'content': p.read_text(encoding='utf-8')}
            elif fn['name'] == 'write_file' and p.name == 'result.txt':
                content = args['content']
                if not isinstance(content, str) or len(content) > 2000:
                    raise ValueError('Invalid write')
                p.write_text(content, encoding='utf-8')
                answer = {'written': True}
            else:
                answer = {'error': 'Tool not allowed'}
            trace.append({'executed': fn['name'], 'file': p.name, 'result': answer})
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(answer)})
    result_file = WORK / 'result.txt'
    success = (result_file.exists() and result_file.read_text(encoding='utf-8') == nonce
        and any(t.get('executed') == 'read_file' and t.get('file') == 'result.txt' for t in trace)
        and any(nonce in str(t.get('message', {}).get('content', '')) for t in trace))
    report = {'local_read_write_read_verified': success, 'trace': trace}
    (ROOT / 'live-tools-test.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
