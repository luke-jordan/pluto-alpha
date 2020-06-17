variable "aws_access_key" {}
variable "aws_secret_access_key" {}
variable "aws_default_region" {
    type = "map"
    default = {
        "staging"  = "us-east-1"
        "master" = "eu-west-1"
    }
}

variable "aws_account" {
    default=  "455943420663"
    type = "string"
}

variable jwt_authorizer_arn {
    default = {
        "staging" = "arn:aws:lambda:us-east-1:455943420663:function:authorizer"
        "master" = "arn:aws:lambda:eu-west-1:455943420663:function:authorizer"
    }
    type = "map"
}

variable user_event_topic_arn {
    default = {
        "staging" = "arn:aws:sns:us-east-1:455943420663:staging_user_event_topic"
        "master" = "arn:aws:sns:eu-west-1:455943420663:master_user_event_topic"
    }
    type = "map"
}

variable "user_status_lambda_arn" {
  default = {
      "staging" = "arn:aws:lambda:us-east-1:455943420663:function:profile_status_update"
      "master" = "arn:aws:lambda:eu-west-1:455943420663:function:profile_status_update"
  }
  type = "map"
}

variable user_profile_table_read_policy_arn {
    default = {
        "staging" = "arn:aws:iam::455943420663:policy/UserProfileTableRead_access_staging"
        "master" = "arn:aws:iam::455943420663:policy/UserProfileTableRead_access_master"
    }
    type = "map"
}

variable user_profile_table_update_policy_arn {
    default = {
        "staging" = "arn:aws:iam::455943420663:policy/profile_status_update_access_staging"
        "master" = "arn:aws:iam::455943420663:policy/profile_status_update_access_master"
    }
    type = "map"
}

variable "user_profile_lookup_by_detail_policy" {
  type = map(string)
  default = {
      "staging" = "arn:aws:iam::455943420663:policy/ProfileFindByDetailsInvokeAccess_staging"
      "master" = "arn:aws:iam::455943420663:policy/ProfileFindByDetailsInvokeAccess_master"
  }
}

variable user_profile_admin_policy_arn {
    default = {
        "staging" = "arn:aws:iam::455943420663:policy/lambda_admin_user_mgmt_staging"
        "master" = "arn:aws:iam::455943420663:policy/lambda_admin_user_mgmt_master"
    }
    type = "map"
}

variable user_profile_history_invoke_policy_arn {
    default = {
        "staging" = "arn:aws:iam::455943420663:policy/staging_lambda_user_history_read"
        "master" = "arn:aws:iam::455943420663:policy/master_lambda_user_history_read"
    }
    type = "map"
}

variable auth_cache_read_policy_arn {
    default = {
        "staging" = "arn:aws:iam::455943420663:policy/AuthCacheReadAccess_staging"
        "master" = "arn:aws:iam::455943420663:policy/AuthCacheReadAccess_master"
    }
    type = "map"
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

variable "db_allocated_storage" {
  default = "20"
}

variable "deploy_code_commit_hash" {
}

variable "events_source_email_address" {
  description = "The source email address that will serve as the origin of various events emails"
  type = "map"
  default = {
      "staging" = "Jupiter System <noreply@jupitersave.com>",
      "master" = "Jupiter System <service@jupitersave.com>"
  }
}

variable "events_email_receipients" {
    description = "Recipient list for daily stats and system emails"
    type = "map"
    default = {
        "staging" = ["luke@jupitersave.com"],
        "master" = ["luke@jupitersave.com", "avish@jupitersave.com"]
    }
}

# todo : make client dependent
variable "events_phone_reciepients" {
    description = "Recipient list for account opened SMSs"
    type = "map"
    default = {
        "staging" = [""],
        "master" = ["+27834013558"]
    }
}

variable "messaging_source_email_address" {
    description = "The source email address for non-event emails, e.g., messages etc"
    type = "map"
    default = {
        "staging" = "Jupiter Team <noreply@jupitersave.com>"
        "master" = "Jupiter Team <hello@jupitersave.com>"
    }
}
