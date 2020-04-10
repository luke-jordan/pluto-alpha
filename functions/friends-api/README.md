# Save With Friends API

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

<a name="addFriendRequest"></a>

## addFriendRequest(event)
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

<a name="addFriendship"></a>

## addFriendship(event)
This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| initiatedUserId | <code>string</code> | Required. The user id of the user who initiated the friendship. |
| acceptedUserId | <code>string</code> | Required. The user id of the user who accepted the friendship. |

<a name="removeFriendship"></a>

## removeFriendship(event)
This functions deactivates a friendship.

**Kind**: global function  

| Param | Type |
| --- | --- |
| event | <code>object</code> | 

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| relationshipId | <code>string</code> | The id of the relationship to be deactivated. |

