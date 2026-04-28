export default {
    id: 'pipeline',
    version: '1.0.0',
    artifactType: 'graph',
    sourceType: 'text/x-ndl',
    metadata: { name: 'Standard Pipeline', description: 'validate → transform → parseResponse', tags: ['user', 'pipeline'] },
    source: `
graph pipeline @version:1.0.0
node vNode @validate
  state schema = { id: { type: "string", required: true } }
node tNode @transform
node rNode @parseResponse
vNode.result -> tNode.data
tNode.result -> rNode.data
    `,
    interface: {
        inputs: { id: { type: 'string', required: true } },
        outputs: { status: { type: 'number' }, body: { type: 'object' }, ok: { type: 'boolean' } }
    }
};
