// You can find the basic Solid concepts explained in the Glossary.md file, inline comments talk about
// the specifics of how this application is implemented.

let user, tasksContainerUrl;
const solidFileClient = new SolidFileClient(solidClientAuthentication);
// new @prefix unknown by solid-namespace
solidFileClient.rdf.setPrefix('schema', 'https://schema.org/');

async function restoreSession() {
    // This function uses Inrupt's authentication library to restore a previous session. If you were
    // already logged into the application last time that you used it, this will trigger a redirect that
    // takes you back to the application. This usually happens without user interaction, but if you hadn't
    // logged in for a while, your identity provider may ask for your credentials again.
    //
    // After a successful login, this will also read the profile from your POD.
    //
    // @see https://docs.inrupt.com/developer-tools/javascript/client-libraries/tutorial/authenticate-browser/

    try {
        await solidClientAuthentication.handleIncomingRedirect({ restorePreviousSession: true });

        const session = solidClientAuthentication.getDefaultSession();

        if (!session.info.isLoggedIn)
            return false;

        user = await fetchUserProfile(session.info.webId);

        return user;
    } catch (error) {
        alert(error.message);

        return false;
    }
}

function getLoginUrl() {
    // Asking for a login url in Solid is kind of tricky. In a real application, you should be
    // asking for a user's webId, and reading the user's profile you would be able to obtain
    // the url of their identity provider. However, most users may not know what their webId is,
    // and they introduce the url of their issue provider directly. In order to simplify this
    // example, we just use the base domain of the url they introduced, and this should work
    // most of the time.
    const url = prompt('Introduce your Solid login url');

    if (!url)
        return null;

    const loginUrl = new URL(url);
    loginUrl.hash = '';
    loginUrl.pathname = '';

    return loginUrl.href;
}

function performLogin(loginUrl) {
    solidClientAuthentication.login({
        oidcIssuer: loginUrl,
        redirectUrl: window.location.href,
        clientName: 'Hello World',
    });
}

async function performLogout() {
    await solidClientAuthentication.logout();
}

async function performTaskCreation(description) {
    // Data discovery mechanisms are still being defined in Solid, but so far it is clear that
    // applications should not hard-code the url of their containers like we are doing in this
    // example.
    //
    // In a real application, you should use one of these two alternatives:
    //
    // - The Type index. This is the one that most applications are using in practice today:
    //   https://github.com/solid/solid/blob/main/proposals/data-discovery.md#type-index-registry
    //
    // - SAI, or Solid App Interoperability. This one is still being defined:
    //   https://solid.github.io/data-interoperability-panel/specification/

    if (!tasksContainerUrl) {
        await createSolidContainer(`${user.storageUrl}tasks/`);

        tasksContainerUrl = `${user.storageUrl}tasks/`;
    }

    const documentUrl = await createSolidDocument(tasksContainerUrl, `
        @prefix schema: <https://schema.org/> .

        <#it>
            a schema:Action ;
            schema:actionStatus schema:PotentialActionStatus ;
            schema:description "${escapeText(description)}" .
    `);
    const taskUrl = `${documentUrl}#it`;

    return { url: taskUrl, description };
}

async function performTaskUpdate(taskUrl, done) {
    const documentUrl = getSolidDocumentUrl(taskUrl);

    await updateSolidDocument(documentUrl, `
        DELETE DATA {
            <#it>
                <https://schema.org/actionStatus>
                <https://schema.org/${done ? 'PotentialActionStatus' : 'CompletedActionStatus'}> .
        } ;
        INSERT DATA {
            <#it>
                <https://schema.org/actionStatus>
                <https://schema.org/${done ? 'CompletedActionStatus' : 'PotentialActionStatus'}> .
        }
    `);
}

async function performTaskDeletion(taskUrl) {
    const documentUrl = getSolidDocumentUrl(taskUrl);

    await deleteSolidDocument(documentUrl);
}

async function loadTasks() {
    // In a real application, you shouldn't hard-code the path to the container like we're doing here.
    // Read more about this in the comments on the performTaskCreation function.

    const tasks = [];
    const containmentQuads = await readSolidDocument(`${user.storageUrl}tasks/`, null, { ldp: 'contains' })

    if (!containmentQuads) {
        return [];
    }

    tasksContainerUrl = `${user.storageUrl}tasks/`;

    for (const containmentQuad of containmentQuads) {
        const [typeQuad] = await readSolidDocument(containmentQuad.object.value, null, null, '<https://schema.org/Action>');

        if (!typeQuad) {
            // Not a Task, we can ignore this document.
            continue;
        }

        const taskUrl = typeQuad.subject.value;

        // https://schema.org ontology : in first line using the 'getPrefix() help, second line with a simple ttl string
        const [descriptionQuad] = await readSolidDocument(containmentQuad.object.value, `<${taskUrl}>`, { schema: 'description' });
        const [statusQuad] = await readSolidDocument(containmentQuad.object.value, `<${taskUrl}>`, '<https://schema.org/actionStatus>');

        tasks.push({
            url: taskUrl,
            description: descriptionQuad?.object.value || '-',
            done: statusQuad?.object.value === 'https://schema.org/CompletedActionStatus',
        });
    }

    return tasks;
}

async function readSolidDocument(url, s, p, o, g) {
    try {
        // rdf.query return an array of statements matching terms (load and cache url content)
        return await solidFileClient.rdf.query(url, s, p, o, g);
    } catch (error) {
        return null;
    }
}

async function createSolidDocument(url, contents) {
    const response = await solidFileClient.post(url, {
        headers: { 'Content-Type': 'text/turtle' },
        body: contents,
    });

    if (!isSuccessfulStatusCode(response.status))
        throw new Error(`Failed creating document at ${url}, returned status ${response.status}`);

    const location = response.headers.get('Location');

    return new URL(location, url).href;
}

async function updateSolidDocument(url, update) {
    const response = await solidFileClient.patchFile(url, update, 'application/sparql-update');

    if (!isSuccessfulStatusCode(response.status))
        throw new Error(`Failed updating document at ${url}, returned status ${response.status}`);
}

async function deleteSolidDocument(url) {
    const response = await solidFileClient.deleteFile(url);

    if (!isSuccessfulStatusCode(response.status))
        throw new Error(`Failed deleting document at ${url}, returned status ${response.status}`);
}

async function createSolidContainer(url) {
    const response = await solidFileClient.createFolder(url)

    if (!isSuccessfulStatusCode(response.status))
        throw new Error(`Failed creating container at ${url}, returned status ${response.status}`);
}

function isSuccessfulStatusCode(statusCode) {
    return Math.floor(statusCode / 100) === 2;
}

function getSolidDocumentUrl(resourceUrl) {
    const url = new URL(resourceUrl);

    url.hash = '';

    return url.href;
}

async function fetchUserProfile(webId) {
    const [nameQuad] = await readSolidDocument(webId, null, { foaf: 'name' })
    return {
        url: webId,
        name: nameQuad?.object.value || webId.split('//')[1].split('/profile')[0], // replace 'Anonymous',
        storageUrl: await findPodStorage(webId),
    };
}

async function findPodStorage(url) {
    url = url.replace(/#.*$/, '');
    url = url.endsWith('/') ? url + '../' : url + '/../';
    url = new URL(url);

    // following solid/protocol used by NSS and CSS
    const [StorageQuad] = await readSolidDocument(url.href, null, null, { space: 'Storage' })

    if (StorageQuad) {
        return url.href
    }

    // for providers that don't advertise storage properly
    if (url.pathname === '/') return url.href

    return findPodStorage(url.href);
}

function escapeText(text) {
    return text.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
}
