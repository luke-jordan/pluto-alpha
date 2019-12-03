// ////////////////// REFERENCE TO CLIENT-FLOAT VARS TABLE /////////////////////////////////
variable "country_client_table_arn" {
  type = "map"
  default = {
    "staging" = "arn:aws:dynamodb:us-east-1:455943420663:table/CountryClientTable"
    "master" = "arn:aws:dynamodb:eu-west-1:455943420663:table/CountryClientTable"
  }
}

// ////////////////// OPS TABLES ///////////////////////////////////////////////////////////
resource "aws_dynamodb_table" "client-float-table" {
  name           = "ClientFloatTable"
  billing_mode   = "PROVISIONED"
  read_capacity  = "${lookup(var.dynamo_tables_read_capacity[terraform.workspace], "client-float-table")}"
  write_capacity = "${lookup(var.dynamo_tables_write_capacity[terraform.workspace], "client-float-table")}"
  hash_key       = "client_id"
  range_key      = "float_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "client_id"
    type = "S"
  }

  attribute {
    name = "float_id"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "system_variable_table" {
  name           = "SystemVariableTable"
  billing_mode   = "PAY_PER_REQUEST"

  hash_key       = "VariableKey"
  range_key      = "LastUpdatedTimestamp"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "VariableKey"
    type = "S"
  }

  attribute {
    name = "LastUpdatedTimestamp"
    type = "N"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "responsible_clients_table" {
  name           = "ClientsTable"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "ClientId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "ClientId"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "active_referral_code_table" {
  name           = "ActiveReferralCodes"
  billing_mode   = "PAY_PER_REQUEST"

  hash_key       = "country_code"
  range_key      = "referral_code"

    point_in_time_recovery {
    enabled = false
  }

  attribute {
    name = "country_code"
    type = "S"
  }

  attribute {
    name = "referral_code"
    type = "S"
  }

  attribute {
    name = "client_id_float_id"
    type = "S"
  }

  global_secondary_index {
    name                = "ReferralCodeFloatIndex"
    hash_key            = "client_id_float_id"
    range_key           = "referral_code"
    projection_type     = "INCLUDE"
    non_key_attributes  = ["context", "country_code", "bonus_source", "tags", "code_type"]
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "archived_referral_code_table" {
  name          = "ArchivedReferralCodeTable"
  billing_mode  = "PAY_PER_REQUEST"

  hash_key      = "referral_code"
  range_key     = "deactivated_time"

  attribute {
    name = "referral_code"
    type = "S"
  }

  attribute {
    name = "deactivated_time"
    type = "N"
  }

  tags = {
    Name          = "environment"
    Environment   = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "admin_log_table" {
  name          = "AdminDynamoLogTable"
  billing_mode  = "PAY_PER_REQUEST"

  hash_key      = "admin_user_id_event_type"
  range_key     = "creation_time"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "admin_user_id_event_type"
    type = "S"
  }

  attribute {
    name = "creation_time"
    type = "N"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}