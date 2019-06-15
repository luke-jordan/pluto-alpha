#!/bin/sh


aws dynamodb delete-table --table-name roles_and_permissions --endpoint-url http://localhost:8000
echo 'Deleted roles and permissions table';