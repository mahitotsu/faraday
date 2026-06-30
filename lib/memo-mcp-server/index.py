import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr

TABLE_NAME = os.environ['DYNAMODB_TABLE']
_table = boto3.resource('dynamodb').Table(TABLE_NAME)


def create_memo(title: str, content: str, tags: list = None):
    if tags is None:
        tags = []
    memo_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    _table.put_item(Item={
        'id': memo_id, 'title': title, 'content': content,
        'tags': tags, 'createdAt': now, 'updatedAt': now,
    })
    return {'id': memo_id, 'title': title, 'createdAt': now}


def list_memos(limit: int = 20, filter_tag: str = None):
    kwargs = {'Limit': min(int(limit), 100)}
    if filter_tag:
        kwargs['FilterExpression'] = Attr('tags').contains(filter_tag)
    resp = _table.scan(**kwargs)
    items = resp.get('Items', [])
    return sorted(items, key=lambda x: x.get('createdAt', ''), reverse=True)


def get_memo(memo_id: str):
    resp = _table.get_item(Key={'id': memo_id})
    return resp.get('Item') or {'error': f'Memo {memo_id} not found'}


def update_memo(
    memo_id: str,
    title: str = None,
    content: str = None,
    tags: list = None,
):
    updates, names, values = {}, {}, {}
    if title is not None:
        updates['#t'] = ':t'
        names['#t'] = 'title'
        values[':t'] = title
    if content is not None:
        updates['#c'] = ':c'
        names['#c'] = 'content'
        values[':c'] = content
    if tags is not None:
        updates['#g'] = ':g'
        names['#g'] = 'tags'
        values[':g'] = tags
    if not updates:
        return {'error': 'No fields to update'}
    now = datetime.now(timezone.utc).isoformat()
    updates['#u'] = ':u'
    names['#u'] = 'updatedAt'
    values[':u'] = now
    expr = 'SET ' + ', '.join(f'{k} = {v}' for k, v in updates.items())
    resp = _table.update_item(
        Key={'id': memo_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ReturnValues='ALL_NEW',
    )
    return resp.get('Attributes', {})


def delete_memo(memo_id: str):
    _table.delete_item(Key={'id': memo_id})
    return {'deleted': memo_id}


def search_memos(query: str):
    q = query.lower()
    resp = _table.scan(
        FilterExpression=Attr('title').contains(q) | Attr('content').contains(q)
    )
    items = resp.get('Items', [])
    return sorted(items, key=lambda x: x.get('createdAt', ''), reverse=True)


HANDLERS = {
    'create_memo': create_memo,
    'list_memos': list_memos,
    'get_memo': get_memo,
    'update_memo': update_memo,
    'delete_memo': delete_memo,
    'search_memos': search_memos,
}


def lambda_handler(event, context):
    print(json.dumps(event, default=str))

    # AgentCore Gateway (Lambda target) passes the tool name via the Lambda
    # context's client context, prefixed with "<targetName>___".
    # https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
    full_tool_name = context.client_context.custom['bedrockAgentCoreToolName']
    delimiter = '___'
    tool_name = full_tool_name[full_tool_name.index(delimiter) + len(delimiter):]

    # The tool's input parameters are passed directly as the event object.
    tool_input = event if isinstance(event, dict) else {}

    handler = HANDLERS.get(tool_name)
    if not handler:
        return {
            'error': f'Unknown tool: {tool_name}',
            'available': list(HANDLERS.keys()),
        }

    try:
        return handler(**tool_input)
    except Exception as e:
        return {
            'error': str(e),
            'tool': tool_name,
            'input': str(tool_input),
        }
