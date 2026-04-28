/** http — input: { url: string, method?: string, headers?: object, body?: any } */
export default {
    id: 'http',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'http', description: 'input: { url, method?, headers?, body? }', tags: ['core'] },
    source: `
        const { url, method = 'GET', headers = {}, body } = input;
        const options = { method, headers: { 'Content-Type': 'application/json', ...headers } };
        if (body && method !== 'GET') options.body = JSON.stringify(body);

        fetch(url, options)
            .then(async res => {
                const ct = res.headers.get('content-type') ?? '';
                const data = ct.includes('json') ? await res.json() : await res.text();
                returnCallback({ output: { status: res.status, body: data, ok: res.ok }, state });
            })
            .catch(err => returnCallback({ output: { ok: false, error: err.message, status: 0 }, state }));
    `,
    interface: {
        inputs:  { url: { type: 'string', required: true }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'any' } },
        outputs: { status: { type: 'number' }, body: { type: 'any' }, ok: { type: 'boolean' } }
    }
};
