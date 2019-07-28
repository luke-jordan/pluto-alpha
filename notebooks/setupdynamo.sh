#! /bin/bash

echo "Creating the DynamoDB table that holds the client floats"
awslocal cloudformation create-stack --template-body file://../templates/dynamodb/client-float-table.yml --stack-name client-float-table

echo "Adding in item for core, ZAR wholesale float"
awslocal dynamodb put-item --table-name ClientFloatTable --item file://../templates/dynamodb/zar_main_float_item.json

echo "Creating the DynamoDB tables that hold user profile information"
awslocal cloudformation create-stack --template-body file://../templates/dynamodb/user-profile-tables.yml --stack-name user-profile-tables

# For when we need it
#  awslocal dynamodb create-table --table-name UserNationalIdTable --attribute-definitions AttributeName=country_code,AttributeType=S AttributeName=national_id,AttributeType=S --key-schema AttributeName=country_code,KeyType=HASH AttributeName=national_id,KeyType=RANGE --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1