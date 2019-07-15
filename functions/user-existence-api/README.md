# USER EXISTENCE

The entities corresponding to users in Jupiter exist in the following hierarchy:

##  User profile

### Entity

Stored in DynamoDB. Holds:

* The system wide user ID (used as a unique identifier in authentication, accounts, etc)
* Personal and contact information, including name, phone, email (and ID number)
* The client company the user signed up through 
* The default float the user saves into 
* The user's current state within the system
* The user's current KYC (know your customer) status and their
risk rating (0 being lowest risk) 
* A flag for whether the user has set a password ("SECURED", as a more general term)
* The user's role (system admin, customer support, ordinary)
* The timestamp for the last time the user logged in (note: full login, not just had an app session, for which see analytics)
* The timestamp for the last time the user profile (i.e., this record) changed
* Any tags relevant to the user (including whether the account has been gifted)

### States

User profiles can be in different states as they go through onboarding. These can be one of:

* CREATED (starting point, means a user has given us a name and a contact)
* ACCOUNT_OPENED (user has created an account, see below)
* USER_HAS_INITIATED_SAVE (user has said they will save, e.g., may have stated a funds transfer is incoming but not completed)
* USER_HAS_SAVED (user has cash in the account)
* USER_HAS_WITHDRAWN (user has completed at least on successful withdrawal of their savings)
* SUSPENDED_FOR_KYC (the user has failed KYC checks and so their profile, and attached accounts, is frozen)

The user also has a SECURED flag, which states whether they have set a password, and a "last_login_event".

### KYC status and risk rating

The KYC status is:

* NO_INFO (base state, means user does not even have ID number or other means to verify)
* CONTACT_VERIFIED (the phone number or email address has been shown to exist and user has verified ownership via OTP)
* PENDING_VERIFICATION_AS_PERSON (user has provided verification information that they are a real person)
* VERIFIED_AS_PERSON (user has been verified as a real person)
* FAILED_VERIFICATION (user has failed verification as a real person)
* FLAGGED_FOR_REVIEW (user behaviour has triggered a risk-based review)
* PENDING_INFORMATION (awaiting information from the user to clear a risk review)
* REVIEW_CLEARED (has cleared the review)
* REVIEW_FAILED (failed the KYC review)

## User account

A user can have multiple accounts, though the vast majority will have only one. An account is tied to a specific client and has a default float, though in future may involve saving in multiple of them. An account is opened as soon as the user is verified as a person.

**Gifted accounts**: One particular form of account is "gifted". That is, a user may create an account for someone else and seed it some initial savings. In that case the first user will be the "opening user", and the second will be the "owning user". For these users, the status will be ACCOUNT_OPENED but other flags will indicate that the user still needs to verify they are a person, provide an ID number, etc.

**Frozen accounts**: An account will become frozen if the user has failed KYC checks