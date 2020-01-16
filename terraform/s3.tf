resource "aws_s3_bucket" "float_record_bucket" {
    bucket = "${terraform.workspace}.jupiter.float.records"
    region = var.aws_default_region[terraform.workspace]
    acl = "private"

    server_side_encryption_configuration {
        rule {
            apply_server_side_encryption_by_default {
                sse_algorithm     = "AES256"
            }
        }
    }
    
    tags = {"environment"  = "${terraform.workspace}"}
}