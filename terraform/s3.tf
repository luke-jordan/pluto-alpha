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

    object_lock_configuration {
        object_lock_enabled = "Enabled"
    }
    
    tags = {"environment"  = "${terraform.workspace}"}
}

resource "aws_s3_bucket_public_access_block" "float_record_block" {
  bucket = aws_s3_bucket.float_record_bucket.id

  block_public_acls   = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
