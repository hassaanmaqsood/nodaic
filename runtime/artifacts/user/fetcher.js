export default {
    id: 'fetcher',
    version: '1.0.0',
    artifactType: 'graph',
    sourceType: 'text/x-ndl',
    metadata: { name: 'HTTP Fetcher', description: 'http → retry', tags: ['user', 'network'] },
    source: `
graph fetcher @version:1.0.0
node httpNode @http
node retryNode @retry
httpNode -> retryNode
    `,
    interface: {
        inputs: { url: { type: 'string', required: true }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'any' } },
        outputs: { status: { type: 'number' }, body: { type: 'any' }, ok: { type: 'boolean' }, attempts: { type: 'number' } }
    }
};
