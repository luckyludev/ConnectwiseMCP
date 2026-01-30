#!/usr/bin/env python3
"""
JSON to SQLite Converter for ConnectWise API

This script converts the large manage.json file containing ConnectWise API definitions
into a SQLite database for efficient querying and lookup.

Usage:
    python json_to_sqlite.py <path_to_manage.json> <output_sqlite_db>
"""

import json
import sqlite3
import sys
import os
import time
from typing import Dict, List, Any, Optional, Union

def create_tables(conn: sqlite3.Connection) -> None:
    """Create the necessary tables in the SQLite database."""
    cursor = conn.cursor()
    
    # Create table for API endpoints
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        method TEXT NOT NULL,
        description TEXT,
        category TEXT,
        summary TEXT,
        tags TEXT,
        UNIQUE(path, method)
    )
    ''')
    
    # Create table for parameters
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS parameters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER,
        name TEXT NOT NULL,
        location TEXT NOT NULL,  -- path, query, body
        required INTEGER,        -- 0 or 1
        type TEXT,
        description TEXT,
        FOREIGN KEY (endpoint_id) REFERENCES endpoints (id)
    )
    ''')
    
    # Create table for request bodies
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS request_bodies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER,
        schema TEXT,              -- JSON schema for the body
        example TEXT,             -- JSON example if available
        FOREIGN KEY (endpoint_id) REFERENCES endpoints (id)
    )
    ''')
    
    # Create table for response bodies
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS response_bodies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER,
        status_code TEXT,
        description TEXT,
        schema TEXT,              -- JSON schema for the response
        example TEXT,             -- JSON example if available
        FOREIGN KEY (endpoint_id) REFERENCES endpoints (id)
    )
    ''')
    
    # Create indexes for faster searches
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(path)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_endpoints_method ON endpoints(method)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_endpoints_tags ON endpoints(tags)')
    
    conn.commit()

def process_json_file(json_path: str, db_path: str) -> None:
    """Process the manage.json file and store the data in SQLite."""
    print(f"Starting processing of: {json_path}")
    start_time = time.time()
    
    # Connect to SQLite database
    conn = sqlite3.connect(db_path)
    create_tables(conn)
    cursor = conn.cursor()
    
    # Open and read the JSON file in chunks to avoid memory issues
    print("Opening JSON file...")
    with open(json_path, 'r') as f:
        # Load the JSON data
        try:
            print("Parsing JSON data...")
            api_data = json.load(f)
            print(f"JSON parsed successfully. Processing...")
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON: {e}")
            conn.close()
            return
    
    # Extract paths and methods from the OpenAPI specification
    if 'paths' not in api_data:
        print("Error: 'paths' key not found in JSON data. Is this a valid OpenAPI specification?")
        conn.close()
        return
    
    paths = api_data['paths']
    total_paths = len(paths)
    processed = 0
    
    # Process each path and its methods
    for path, path_data in paths.items():
        for method, method_data in path_data.items():
            if method in ['get', 'post', 'put', 'patch', 'delete']:
                # Extract endpoint data
                description = method_data.get('description', '')
                summary = method_data.get('summary', '')
                tags = ','.join(method_data.get('tags', []))
                
                # Determine category from tags or path
                category = method_data.get('tags', [''])[0] if method_data.get('tags') else path.split('/')[1] if len(path.split('/')) > 1 else 'unknown'
                
                # Insert endpoint data
                cursor.execute('''
                INSERT OR REPLACE INTO endpoints (path, method, description, category, summary, tags)
                VALUES (?, ?, ?, ?, ?, ?)
                ''', (path, method, description, category, summary, tags))
                
                endpoint_id = cursor.lastrowid
                
                # Process parameters
                parameters = method_data.get('parameters', [])
                for param in parameters:
                    name = param.get('name', '')
                    location = param.get('in', '')  # path, query, header, etc.
                    required = 1 if param.get('required', False) else 0
                    param_type = param.get('schema', {}).get('type', '') if 'schema' in param else param.get('type', '')
                    param_description = param.get('description', '')
                    
                    cursor.execute('''
                    INSERT INTO parameters (endpoint_id, name, location, required, type, description)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ''', (endpoint_id, name, location, required, param_type, param_description))
                
                # Process request body if present
                if 'requestBody' in method_data:
                    request_body = method_data['requestBody']
                    content = request_body.get('content', {})
                    content_type = next(iter(content)) if content else ''
                    
                    schema = json.dumps(content.get(content_type, {}).get('schema', {})) if content_type else '{}'
                    example = json.dumps(content.get(content_type, {}).get('example', {})) if content_type else '{}'
                    
                    cursor.execute('''
                    INSERT INTO request_bodies (endpoint_id, schema, example)
                    VALUES (?, ?, ?)
                    ''', (endpoint_id, schema, example))
                
                # Process responses
                responses = method_data.get('responses', {})
                for status_code, response_data in responses.items():
                    description = response_data.get('description', '')
                    content = response_data.get('content', {})
                    content_type = next(iter(content)) if content else ''
                    
                    schema = json.dumps(content.get(content_type, {}).get('schema', {})) if content_type else '{}'
                    example = json.dumps(content.get(content_type, {}).get('example', {})) if content_type else '{}'
                    
                    cursor.execute('''
                    INSERT INTO response_bodies (endpoint_id, status_code, description, schema, example)
                    VALUES (?, ?, ?, ?, ?)
                    ''', (endpoint_id, status_code, description, schema, example))
        
        processed += 1
        if processed % 50 == 0:
            print(f"Processed {processed}/{total_paths} paths ({(processed/total_paths)*100:.1f}%)...")
            # Commit periodically to avoid large transactions
            conn.commit()
    
    # Final commit
    conn.commit()
    conn.close()
    
    elapsed_time = time.time() - start_time
    print(f"Processing completed in {elapsed_time:.2f} seconds.")
    print(f"Database created at: {db_path}")

def main():
    if len(sys.argv) < 3:
        print("Usage: python json_to_sqlite.py <path_to_manage.json> <output_sqlite_db>")
        sys.exit(1)
        
    json_path = sys.argv[1]
    db_path = sys.argv[2]
    
    if not os.path.exists(json_path):
        print(f"Error: JSON file does not exist at path: {json_path}")
        sys.exit(1)
    
    process_json_file(json_path, db_path)

if __name__ == "__main__":
    main()
