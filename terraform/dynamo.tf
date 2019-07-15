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

resource "aws_dynamodb_table" "user_profile_table" {
  name           = "UserProfileTable"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "system_wide_user_id"
  
  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "system_wide_user_id"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "user_national_id_table" {
  name          = "UserNationalIdTable"
  billing_mode  = "PAY_PER_REQUEST"
  hash_key      = "country_code"
  range_key     = "national_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "country_code"
    type = "S"
  }

  attribute {
    name = "national_id"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "user_phone_table" {
  name           = "UserPhoneTable"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "phone_number"
  
  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "phone_number"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "user_email_table" {
  name           = "UserEmailTable"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "email_address"
  
  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "email_address"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}

resource "aws_dynamodb_table" "system_variable_table" {
  name           = "SystemVariableTable"
  billing_mode   = "PROVISIONED"
  read_capacity  = "${lookup(var.dynamo_tables_read_capacity[terraform.workspace], "system_variable_table")}"
  write_capacity = "${lookup(var.dynamo_tables_write_capacity[terraform.workspace], "system_variable_table")}"
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
  name           = "ResponsibleClientsTable"
  billing_mode   = "PROVISIONED"
  read_capacity  = "${lookup(var.dynamo_tables_read_capacity[terraform.workspace], "responsible_clients_table")}"
  write_capacity = "${lookup(var.dynamo_tables_write_capacity[terraform.workspace], "responsible_clients_table")}"
  hash_key       = "ResponsibleClientId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "ResponsibleClientId"
    type = "S"
  }

  tags = {
    Name        = "environment"
    Environment = "${terraform.workspace}"
  }
}
