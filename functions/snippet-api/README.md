# Snippet API

## Functions

<dl>
<dt><a href="#listSnippets">listSnippets(event)</a></dt>
<dd><p>This function list all active snippets for an admin user (also includes how many times each
snippet has been created for users).</p>
</dd>
<dt><a href="#viewSnippet">viewSnippet(event)</a></dt>
<dd><p>This function fetches major snippet details (sucj as title, text, the number of users it has been created for
how many times the snippet has been fetched and viewed, etc) for a defined snippet for an admin user.</p>
</dd>
<dt><a href="#addUserToPreviewList">addUserToPreviewList(event)</a></dt>
<dd><p>Adds a new preview user, i.e a user who may preview snippets (to make snippets available for
preview set the value of the snippets preview_mode property to true).</p>
</dd>
<dt><a href="#removeUserFromPreviewList">removeUserFromPreviewList(event)</a></dt>
<dd><p>Removes a preview user. Users put through this process will no longer have access to snippets
in preview mode.</p>
</dd>
<dt><a href="#createSnippet">createSnippet(event)</a></dt>
<dd><p>This function creates a new snippet.</p>
</dd>
<dt><a href="#updateSnippetStateForUser">updateSnippetStateForUser(event)</a></dt>
<dd><p>Updates a snippets status to FETCHED or VIEWED.</p>
</dd>
<dt><a href="#fetchSnippetsForUser">fetchSnippetsForUser(event)</a></dt>
<dd><p>This function fetches snippets to be displayed to a user. If there are snippets a user has not viewed
those are returned first, if not then previously viewed snippets are returned.</p>
</dd>
<dt><a href="#updateSnippet">updateSnippet(event)</a></dt>
<dd><p>This function updates a snippets properties. The only property updates allowed by the this function are
the snippets text, title, active status, and priority.</p>
</dd>
</dl>

<a name="listSnippets"></a>

## listSnippets(event)
This function list all active snippets for an admin user (also includes how many times each
snippet has been created for users).

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

<a name="viewSnippet"></a>

## viewSnippet(event)
This function fetches major snippet details (sucj as title, text, the number of users it has been created for
how many times the snippet has been fetched and viewed, etc) for a defined snippet for an admin user.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| snippetId | <code>string</code> | The identifier of the snippet whose properties are to be retrieved. |

<a name="addUserToPreviewList"></a>

## addUserToPreviewList(event)
Adds a new preview user, i.e a user who may preview snippets (to make snippets available for
preview set the value of the snippets preview_mode property to true).

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The user id of the new preview user. |

<a name="removeUserFromPreviewList"></a>

## removeUserFromPreviewList(event)
Removes a preview user. Users put through this process will no longer have access to snippets
in preview mode.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The identifier of the user to be removed from the list of preview users. |

<a name="createSnippet"></a>

## createSnippet(event)
This function creates a new snippet.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| text | <code>string</code> | The main snippet text. |
| active | <code>boolean</code> | Optional property that can be used to create inactive snippets. All new snippets are active by default. |
| responseOptions | <code>object</code> | An object containing the possible response options to be displayed with the snippet. |

<a name="updateSnippetStateForUser"></a>

## updateSnippetStateForUser(event)
Updates a snippets status to FETCHED or VIEWED.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | A user, admin, or direct invocation. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| snippetIds | <code>array</code> | An array of snippet ids. |
| userId | <code>string</code> | The identifier of the user associated with the above snippet ids. |
| status | <code>string</code> | The new status. Valid values are FETCHED and VIEWED. |

<a name="fetchSnippetsForUser"></a>

## fetchSnippetsForUser(event)
This function fetches snippets to be displayed to a user. If there are snippets a user has not viewed
those are returned first, if not then previously viewed snippets are returned.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | A user or admin event. |

<a name="updateSnippet"></a>

## updateSnippet(event)
This function updates a snippets properties. The only property updates allowed by the this function are
the snippets text, title, active status, and priority.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | User or admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| snippetId | <code>string</code> | The identifer of the snippet to be updated. |
| title | <code>string</code> | The value entered here will update the snippet's title. |
| body | <code>string</code> | The value entered here will update the main snippet text. |
| active | <code>boolean</code> | Can be used to activate or deactivate a snippet. |
| snippetPriority | <code>number</code> | Used to update the snippets priority. |

