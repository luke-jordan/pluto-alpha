#!/bin/sh

# for local setup. Remove all occurances of '--endpoint-url http://localhost:8000' to setup on aws
# assumes no tables exists


echo 'Now creating roles and permissions table anew';
aws dynamodb create-table \
    --table-name roles_and_permissions \
    --attribute-definitions \
        AttributeName=policy_id,AttributeType=S \
    --key-schema AttributeName=policy_id,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=2,WriteCapacityUnits=2 \
    --endpoint-url http://localhost:8000;
echo 'Table creation complete';


echo 'Now inserting policies';
aws dynamodb put-item \
    --table-name roles_and_permissions \
    --item file://support_policy.json \
    --endpoint-url http://localhost:8000;

aws dynamodb put-item \
    --table-name roles_and_permissions \
    --item file://admin_policy.json \
    --endpoint-url http://localhost:8000;

aws dynamodb put-item \
    --table-name roles_and_permissions \
    --item file://default_policy.json \
    --endpoint-url http://localhost:8000;
echo 'policy insertion complete';


echo 'Result of inertion:'
# visualise the result of the above commands
aws dynamodb scan --table-name roles_and_permissions --endpoint-url http://localhost:8000;