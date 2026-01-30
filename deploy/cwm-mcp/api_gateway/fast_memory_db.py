#!/usr/bin/env python3
"""
Fast Memory API Database Module

This module provides functionality to store and retrieve successful API calls
from a 'fast memory' database for quicker access to commonly used queries.
"""

import os
import sqlite3
import json
import logging
import time
from typing import Dict, List, Any, Optional, Union, Tuple

# Set up logging
logger = logging.getLogger("api_gateway.fast_memory")

class FastMemoryDB:
    """Class to handle the Fast Memory API database operations."""
    
    def __init__(self, db_path: str):
        """Initialize the database connection and create tables if needed."""
        self.db_path = db_path
        self.conn = None
        
        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        
        # Connect and initialize
        self.connect()
        self.initialize_db()
    
    def connect(self) -> None:
        """Establish a connection to the SQLite database."""
        self.conn = sqlite3.connect(self.db_path)
        # Enable dictionary access to rows
        self.conn.row_factory = sqlite3.Row
        logger.info(f"Connected to Fast Memory DB at {self.db_path}")
    
    def close(self) -> None:
        """Close the database connection."""
        if self.conn:
            self.conn.close()
            self.conn = None
    
    def initialize_db(self) -> None:
        """Create the necessary tables if they don't exist."""
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        # Create the saved_queries table
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS saved_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            path TEXT NOT NULL,
            method TEXT NOT NULL,
            params TEXT,
            data TEXT,
            timestamp INTEGER NOT NULL,
            usage_count INTEGER DEFAULT 0
        )
        ''')
        
        self.conn.commit()
        logger.info("Fast Memory DB initialized")
    
    def save_query(self, description: str, path: str, method: str, 
                  params: Optional[Dict[str, Any]] = None, 
                  data: Optional[Dict[str, Any]] = None) -> int:
        """
        Save a successful API query to the database.
        
        Args:
            description: User-friendly description of the query
            path: API endpoint path
            method: HTTP method
            params: Query parameters
            data: Request body data
            
        Returns:
            ID of the saved query
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        # Check if this query already exists
        cursor.execute('''
        SELECT id FROM saved_queries
        WHERE path = ? AND method = ?
        ''', (path, method))
        
        existing = cursor.fetchone()
        if existing:
            # Update usage count for existing query
            cursor.execute('''
            UPDATE saved_queries
            SET usage_count = usage_count + 1,
                timestamp = ?,
                params = ?,
                data = ?
            WHERE id = ?
            ''', (
                int(time.time()),
                json.dumps(params) if params else None,
                json.dumps(data) if data else None,
                existing['id']
            ))
            self.conn.commit()
            logger.info(f"Updated existing query: {path} {method}")
            return existing['id']
        
        # Insert new query
        cursor.execute('''
        INSERT INTO saved_queries (description, path, method, params, data, timestamp, usage_count)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ''', (
            description,
            path,
            method,
            json.dumps(params) if params else None,
            json.dumps(data) if data else None,
            int(time.time())
        ))
        
        self.conn.commit()
        query_id = cursor.lastrowid
        logger.info(f"Saved new query: {path} {method} with ID {query_id}")
        return query_id
    
    def find_query(self, path: str, method: str) -> Optional[Dict[str, Any]]:
        """
        Find a query by path and method.
        
        Args:
            path: API endpoint path
            method: HTTP method
            
        Returns:
            Query details or None if not found
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        cursor.execute('''
        SELECT * FROM saved_queries
        WHERE path = ? AND method = ?
        ''', (path, method))
        
        result = cursor.fetchone()
        if not result:
            return None
        
        # Convert to dictionary and parse JSON fields
        query = dict(result)
        if query.get('params'):
            try:
                query['params'] = json.loads(query['params'])
            except json.JSONDecodeError:
                query['params'] = None
                
        if query.get('data'):
            try:
                query['data'] = json.loads(query['data'])
            except json.JSONDecodeError:
                query['data'] = None
                
        return query
    
    def search_queries(self, search_term: str) -> List[Dict[str, Any]]:
        """
        Search for saved queries matching the search term.
        
        Args:
            search_term: Term to search for in descriptions and paths
            
        Returns:
            List of matching queries
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        search_pattern = f"%{search_term}%"
        
        cursor.execute('''
        SELECT * FROM saved_queries
        WHERE description LIKE ? OR path LIKE ?
        ORDER BY usage_count DESC, timestamp DESC
        ''', (search_pattern, search_pattern))
        
        results = []
        for row in cursor.fetchall():
            query = dict(row)
            # Parse JSON fields
            if query.get('params'):
                try:
                    query['params'] = json.loads(query['params'])
                except json.JSONDecodeError:
                    query['params'] = None
                    
            if query.get('data'):
                try:
                    query['data'] = json.loads(query['data'])
                except json.JSONDecodeError:
                    query['data'] = None
                    
            results.append(query)
            
        return results
    
    def get_all_queries(self) -> List[Dict[str, Any]]:
        """
        Get all saved queries.
        
        Returns:
            List of all saved queries
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        cursor.execute('''
        SELECT * FROM saved_queries
        ORDER BY usage_count DESC, timestamp DESC
        ''')
        
        results = []
        for row in cursor.fetchall():
            query = dict(row)
            # Parse JSON fields
            if query.get('params'):
                try:
                    query['params'] = json.loads(query['params'])
                except json.JSONDecodeError:
                    query['params'] = None
                    
            if query.get('data'):
                try:
                    query['data'] = json.loads(query['data'])
                except json.JSONDecodeError:
                    query['data'] = None
                    
            results.append(query)
            
        return results
    
    def increment_usage(self, query_id: int) -> None:
        """
        Increment the usage count for a query.
        
        Args:
            query_id: ID of the query
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        cursor.execute('''
        UPDATE saved_queries
        SET usage_count = usage_count + 1,
            timestamp = ?
        WHERE id = ?
        ''', (int(time.time()), query_id))
        
        self.conn.commit()
    
    def delete_query(self, query_id: int) -> bool:
        """
        Delete a saved query.
        
        Args:
            query_id: ID of the query to delete
            
        Returns:
            True if successful, False otherwise
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        cursor.execute('DELETE FROM saved_queries WHERE id = ?', (query_id,))
        self.conn.commit()
        
        return cursor.rowcount > 0
    
    def clear_all(self) -> int:
        """
        Clear all saved queries.
        
        Returns:
            Number of queries deleted
        """
        if not self.conn:
            self.connect()
        
        cursor = self.conn.cursor()
        
        cursor.execute('DELETE FROM saved_queries')
        self.conn.commit()
        
        return cursor.rowcount

# Example usage
if __name__ == "__main__":
    # Use a test database
    db = FastMemoryDB("test_fast_memory.db")
    
    # Save a test query
    db.save_query(
        "Get all open tickets", 
        "/service/tickets", 
        "GET",
        {"conditions": "status/name='Open'"}
    )
    
    # Retrieve all queries
    queries = db.get_all_queries()
    for query in queries:
        print(f"ID: {query['id']}")
        print(f"Description: {query['description']}")
        print(f"Path: {query['path']} {query['method']}")
        print(f"Parameters: {query['params']}")
        print(f"Usage Count: {query['usage_count']}")
        print()
    
    db.close()
