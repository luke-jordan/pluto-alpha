variable "aws_access_key" {}
variable "aws_secret_access_key" {}
variable "aws_default_region" {
    type = "map"
    default = {
        "staging"  = "us-east-1"
        "master" = "eu-west-1"
    }
}

variable "dynamo_tables_read_capacity" {
    default = {
        "staging"  = {
            "responsible_clients_table" = 1
            "system_variable_table" = 1
            "password_policy_table" = 1
            "client-float-table" = 1
        }
        "master" = {
            "responsible_clients_table" = 2
            "system_variable_table" = 2
            "password_policy_table" = 2
            "client-float-table" = 2
        }
    }
}

variable "dynamo_tables_write_capacity" {
    default = {
        "staging"  = {
            "responsible_clients_table" = 1
            "system_variable_table" = 1
            "password_policy_table" = 1
            "client-float-table" = 1
        }
        "master" = {
            "responsible_clients_table" = 2
            "system_variable_table" = 2
            "password_policy_table" = 2
            "client-float-table" = 2
        }
    }
}

variable "az_count" {
  description = "Number of AZs to cover in a given AWS region"
  default     = "2"
}

variable "db_instance_class" {
  default = "db.t2.micro"
}
variable "db_allocated_storage" {
  default = "10"
}

variable "deploy_code_commit_hash" {
}
