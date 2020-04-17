# Friends (Saving Buddies) API

## Functions

<a name="obtainFriends"></a>

## obtainFriends(event)
This functions accepts a users system id and returns the user's friends.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | Required. The user id of the user whose friends are to be extracted. |

<a name="addFriendshipRequest"></a>

## addFriendshipRequest(event)
This function persists a new friendship request.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| initiatedUserId | <code>string</code> | Required. The user id of the user initiating the friendship. |
| targetUserId | <code>string</code> | Required in the absence of targetContactDetails. The user id of the user whose friendship is being requested. |
| targetContactDetails | <code>string</code> | Required in the absence of targetUserId. Either the phone or email of the user whose friendship is being requested. |

<a name="connectFriendshipRequest"></a>

## connectFriendshipRequest(event, systemWideUserId, requestCode)
This function completes a previously ambigious friend request, where a friend was requested using a contact detail not
associated with any system user id. This function is called once the target user has confirmed they are are indeed the target for the
friendship. It accepts a request code (to identify the request) and the target users system id. The friendship request is
sought and the user id is added to its targetUserId field.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> |  |
| systemWideUserId | <code>string</code> | The target/accepting users system wide id |
| requestCode | <code>string</code> | The request code geneated during friend request creation. Used to find the persisted friend request. |

<a name="acceptFriendshipRequest"></a>

## acceptFriendshipRequest(event)
This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestId | <code>string</code> | Required. The The friendships request id. |

<a name="deactivateFriendship"></a>

## deactivateFriendship(event)
This functions deactivates a friendship.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| relationshipId | <code>string</code> | The id of the relationship to be deactivated. |

